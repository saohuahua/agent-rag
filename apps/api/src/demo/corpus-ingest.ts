import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { GatewayService } from '../gateway/gateway.service'
import { ChunkRepository } from '../rag/chunk.repository'
import type { InsertChunk } from '../rag/chunk.repository'
import { chunkBlocks } from '../rag/chunker'
import { tokenize } from '../rag/tokenizer'
import type { TextBlock } from '../rag/parser/types'
import type { PrismaService } from '../prisma/prisma.service'
import { DocSourceType, DocStatus } from '../generated/prisma/enums'
import type { TenantCtx } from '@agent-rag/shared'

/** embedding 批大小 与 rag/ingest.processor 保持一致 */
const EMBED_BATCH = 32

/** corpus 三个语料子目录 */
const CORPUS_SUBDIRS = ['laws', 'rules', 'helpdocs'] as const

/** 语料入库结果 */
export interface CorpusIngestResult {
  files: number
  created: number
  cached: number
  chunks: number
}

/**
 * 语料入库：corpus/ 下的 md → 解析为单 TextBlock → 分块 → 分词 → 向量化 → 事务入库
 * 为什么不做 PDF/DOCX 解析：语料是 md 直接当纯文本块走 chunker 分块 跳过解析器
 * 幂等：doc 按 (datasetId, checksum) 去重 已 INDEXED 的直接跳过（嵌入缓存 评测复跑不再烧 embedding）
 * @param opts 依赖与目标企业/数据集
 */
export async function ingestCorpus(opts: {
  prisma: PrismaService
  gateway: GatewayService
  chunks: ChunkRepository
  enterpriseId: number
  datasetId: number
  memberId: number
  corpusDir: string
  limit?: number
}): Promise<CorpusIngestResult> {
  const files = collectMdFiles(opts.corpusDir)
  const selected = opts.limit ? files.slice(0, opts.limit) : files

  let created = 0
  let cached = 0
  let chunkTotal = 0

  for (const file of selected) {
    const { docId, body } = parseMd(file)
    if (!body) continue

    const checksum = createHash('sha256').update(body).digest('hex')

    // 幂等：同数据集同内容 命中即跳过（嵌入缓存语义）
    const existing = await opts.prisma.knowledgeDoc.findUnique({
      where: { datasetId_checksum: { datasetId: opts.datasetId, checksum } },
    })
    if (existing && existing.status === DocStatus.INDEXED) {
      cached++
      continue
    }

    // 找到就复用 否则建 doc
    const doc = existing ?? (await opts.prisma.knowledgeDoc.create({
      data: {
        datasetId: opts.datasetId,
        enterpriseId: opts.enterpriseId,
        title: docId,
        sourceType: DocSourceType.MANUAL,
        storageKey: path.relative(opts.corpusDir, file),
        mimeType: 'text/markdown',
        sizeBytes: Buffer.byteLength(body),
        checksum,
        status: DocStatus.UPLOADED,
        uploadedBy: opts.memberId,
      },
    }))

    // 单 TextBlock 分块 heading 用 doc_id 供追溯
    const block: TextBlock = { text: body, page: null, headingPath: [docId], isTable: false }
    const drafts = chunkBlocks([block])

    // 分词 + 向量化（批量内聚）
    const insertChunks = await vectorize(opts.gateway, opts.enterpriseId, opts.memberId, drafts)

    // 事务入库（幂等 upsert）+ 状态置 INDEXED
    await opts.chunks.ingest(doc.id, insertChunks)

    created++
    chunkTotal += insertChunks.length
  }

  return { files: selected.length, created, cached, chunks: chunkTotal }
}

/** 收集 corpus 三个子目录全部 md 稳定排序保证可复现 */
function collectMdFiles(corpusDir: string): string[] {
  const out: string[] = []
  for (const sub of CORPUS_SUBDIRS) {
    const dir = path.join(corpusDir, sub)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md')) out.push(path.join(dir, f))
    }
  }
  return out.sort()
}

/**
 * 解析 md：剥 frontmatter 拿 doc_id 正文作为纯文本
 * 为什么剥 frontmatter：source URL/采集日期/tags 是元数据噪声 进 chunk 会污染词法检索
 * @returns docId（frontmatter 的 doc_id 缺省用文件名）与正文
 */
function parseMd(file: string): { docId: string; body: string } {
  const raw = fs.readFileSync(file, 'utf8')
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw)

  let docId = path.basename(file).replace(/\.md$/, '').replace(/-\d{3,}$/, '')
  let body = raw

  if (fm) {
    const m = /^doc_id:\s*(.+)$/m.exec(fm[1] ?? '')
    if (m?.[1]) docId = m[1].trim()
    body = raw.slice(fm[0].length)
  }

  return { docId, body: body.trim() }
}

/** 分词 + 向量化 返回待入库 chunk 描述（与 rag/ingest.processor 同款） */
async function vectorize(
  gateway: GatewayService,
  enterpriseId: number,
  memberId: number,
  drafts: Array<{ content: string; page: number | null; headingPath: string | null }>,
): Promise<InsertChunk[]> {
  const result: InsertChunk[] = []
  const ctx: TenantCtx = { enterpriseId, memberId, role: 'MEMBER' }

  for (let i = 0; i < drafts.length; i += EMBED_BATCH) {
    const batch = drafts.slice(i, i + EMBED_BATCH)
    const vecs = await gateway.embedMany(batch.map(d => d.content), ctx)

    batch.forEach((d, j) => {
      const tokens = tokenize(d.content)
      result.push({
        seq: i + j,
        content: d.content,
        page: d.page,
        headingPath: d.headingPath,
        tokenCount: tokens.length,
        embedding: vecs[j] ?? [],
        tokens,
      })
    })
  }

  return result
}
