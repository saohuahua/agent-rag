import { Logger } from '@nestjs/common'
import { Processor, WorkerHost } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
import { PrismaService } from '../prisma/prisma.service'
import { DocStatus } from '../generated/prisma/enums'
import { GatewayService } from '../gateway/gateway.service'
import { PdfParser } from './parser/pdf-parser'
import { DocxParser } from './parser/docx-parser'
import { checkQuality } from './parser/quality'
import { chunkBlocks } from './chunker'
import { tokenize } from './tokenizer'
import { ChunkRepository } from './chunk.repository'
import type { InsertChunk } from './chunk.repository'
import { readUpload } from './storage'
import type { TextBlock } from './parser/types'
import type { TenantCtx } from '@agent-rag/shared'

/** 队列名 上传入队与 worker 消费共用 */
export const DOC_INGEST_QUEUE = 'doc-ingest'

/** DOCX 官方 MIME */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** embedding 批大小 批量内聚 网关内部无感 */
const EMBED_BATCH = 32

/**
 * 入库 worker 解析→分块→分词→向量化→事务入库
 * 为什么异步入库：PDF 解析分钟级 不能阻塞上传 HTTP 响应 上传即返回
 * 为什么终态判断跳过：jobId=docId 幂等 重跑已 INDEXED 的文档直接返回
 */
@Processor(DOC_INGEST_QUEUE)
export class IngestProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestProcessor.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: GatewayService,
    private readonly pdf: PdfParser,
    private readonly docx: DocxParser,
    private readonly chunks: ChunkRepository,
  ) {
    super()
  }

  /**
   * 处理单个文档入库任务
   * @param job BullMQ 任务 job.data.docId 为目标文档 id
   */
  async process(job: Job<{ docId: number }>): Promise<void> {
    const docId = job.data.docId

    const doc = await this.prisma.knowledgeDoc.findUnique({ where: { id: docId } })
    if (!doc) {
      this.logger.warn(`doc ${docId} not found, skip`)
      return
    }

    // 终态跳过 幂等（OCR_NEEDED 是人工流程终态 INDEXED 是成功终态）
    if (doc.status === DocStatus.INDEXED || doc.status === DocStatus.OCR_NEEDED) {
      this.logger.log(`doc ${docId} already ${doc.status}, skip`)
      return
    }

    // 转解析中 单 job 顺序执行无并发 直接 update 即可
    await this.prisma.knowledgeDoc.update({ where: { id: docId }, data: { status: DocStatus.PARSING } })
    await job.updateProgress(10)

    try {
      const buffer = readUpload(doc.storageKey)
      const blocks = await this.parseByMime(doc.mimeType, buffer)

      // 质量探测 乱码/空文本 终态 OCR_NEEDED 不硬解
      const fullText = blocks.map(b => b.text).join('\n')
      const q = checkQuality(fullText)
      if (!q.ok) {
        await this.prisma.knowledgeDoc.update({
          where: { id: docId },
          data: { status: DocStatus.OCR_NEEDED, parseError: q.reason },
        })
        this.logger.warn(`doc ${docId} OCR_NEEDED: ${q.reason}`)
        return
      }

      // 分块
      const drafts = chunkBlocks(blocks)
      await job.updateProgress(50)

      // 分词 + 向量化（32/批内聚）
      const insertChunks = await this.vectorize(doc.enterpriseId, doc.uploadedBy, drafts)
      await job.updateProgress(90)

      // 单事务入库 幂等 upsert
      await this.chunks.ingest(docId, insertChunks)
      await job.updateProgress(100)
      this.logger.log(`doc ${docId} INDEXED with ${insertChunks.length} chunks`)
    } catch (e) {
      // 失败标 FAILED 并抛错走 BullMQ 重试 注意 FAILED 非终态 重试会再进
      await this.prisma.knowledgeDoc.update({
        where: { id: docId },
        data: { status: DocStatus.FAILED, parseError: errorText(e) },
      })
      throw e
    }
  }

  /** 按 mime 分发解析器 未知类型抛错 */
  private async parseByMime(mimeType: string, buffer: Buffer): Promise<TextBlock[]> {
    if (mimeType === 'application/pdf') return this.pdf.parse(buffer)
    if (mimeType === DOCX_MIME) return this.docx.parse(buffer)
    throw new Error(`unsupported mime type: ${mimeType}`)
  }

  /**
   * 分词 + 向量化 产出入库描述
   * 为什么 32/批：单次 embedding 调用内聚成批 减少 HTTP 往返 网关内部无感
   * @param enterpriseId 租户 id 计量归属
   * @param uploadedBy 上传人 id 计量归属
   * @param drafts 分块草稿
   */
  private async vectorize(enterpriseId: number, uploadedBy: number, drafts: Array<{ content: string; page: number | null; headingPath: string | null }>): Promise<InsertChunk[]> {
    const result: InsertChunk[] = []
    const ctx: TenantCtx = { enterpriseId, memberId: uploadedBy, role: 'MEMBER' }

    for (let i = 0; i < drafts.length; i += EMBED_BATCH) {
      const batch = drafts.slice(i, i + EMBED_BATCH)
      const vecs = await this.gateway.embedMany(batch.map(d => d.content), ctx)

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
}

/** 异常转英文描述 */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
