import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { ingestCorpus } from './corpus-ingest'
import { loadGolden } from './golden'
import { buildDemoServices } from './bootstrap'
import type { GoldenQuestion } from './golden'
import type { PrismaService } from '../prisma/prisma.service'
import type { GatewayService } from '../gateway/gateway.service'
import type { RetrievalService } from '../rag/retrieval.service'
import type { ChunkRepository } from '../rag/chunk.repository'
import type { RetrievalHit } from '@agent-rag/shared'

/** 仓库根（脚本从 apps/api 起进程 向上两级） */
const REPO_ROOT = path.resolve(process.cwd(), '../..')

/** 评测分组（三组消融） */
const CHANNELS = ['lexical', 'vector', 'auto'] as const
type Channel = (typeof CHANNELS)[number]

/** 单题单通道结果 */
interface QueryResult {
  qid: string
  channel: Channel
  latencyMs: number
  hits: RetrievalHit[]
  recallAt5: boolean
  recallAt10: boolean
  firstRank: number | null
}

/** 分组聚合 */
interface GroupStat {
  channel: Channel
  total: number
  recallAt5: number
  recallAt10: number
  mrr10: number
  p95Ms: number
  p50Ms: number
}

/** 命中判定：chunk 正文含任一 gold 关键词（30-评测/01 §1 的关键词近似口径） */
function hitKeyword(content: string, keywords: string[]): boolean {
  return keywords.some(k => content.includes(k))
}

/** 单题跑一次检索 返回指标 */
async function runQuery(
  retrieval: RetrievalService,
  enterpriseId: number,
  q: GoldenQuestion,
  channel: Channel,
): Promise<QueryResult> {
  const t0 = Date.now()
  const hits = await retrieval.hybridSearch({ enterpriseId, query: q.question, topK: 10, channel })
  const latencyMs = Date.now() - t0

  const top5 = hits.slice(0, 5)
  const top10 = hits.slice(0, 10)

  const recallAt5 = top5.some(h => hitKeyword(h.content, q.goldKeywords))
  const recallAt10 = top10.some(h => hitKeyword(h.content, q.goldKeywords))

  // 首个命中名次 1 起 无命中 null
  let firstRank: number | null = null
  for (let i = 0; i < top10.length; i++) {
    if (hitKeyword(top10[i]!.content, q.goldKeywords)) {
      firstRank = i + 1
      break
    }
  }

  return { qid: q.id, channel, latencyMs, hits, recallAt5, recallAt10, firstRank }
}

/** 分位数 就近取值 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx] ?? 0
}

/** 聚合一组指标 只统计非拒答题（拒答单独报告） */
function aggregate(results: QueryResult[], channel: Channel): GroupStat {
  const rows = results.filter(r => r.channel === channel)
  const total = rows.length
  const recallAt5 = total ? rows.filter(r => r.recallAt5).length / total : 0
  const recallAt10 = total ? rows.filter(r => r.recallAt10).length / total : 0

  const mrr10 = total
    ? rows.reduce((sum, r) => sum + (r.firstRank ? 1 / r.firstRank : 0), 0) / total
    : 0

  const latencies = rows.map(r => r.latencyMs)
  return {
    channel,
    total,
    recallAt5,
    recallAt10,
    mrr10,
    p95Ms: percentile(latencies, 95),
    p50Ms: percentile(latencies, 50),
  }
}

/** 报告头部固定写入 commit/语料日期/运行日期（30-评测/01 §4 复现要求） */
function collectMeta(): { commit: string; corpusDate: string; runDate: string } {
  let commit = 'unknown'
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    // 无 git 环境时留 unknown
  }

  // 语料采集日期从任一 .md 的 frontmatter collected_at 读（README 无单点日期字段）
  let corpusDate = 'unknown'
  try {
    const dir = path.join(REPO_ROOT, 'corpus', 'laws')
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 1500)
      const m = /collected_at:\s*([\d-]+)/.exec(head)
      if (m?.[1]) {
        corpusDate = m[1]
        break
      }
    }
  } catch {
    // 读不到时留 unknown
  }

  return { commit, corpusDate, runDate: new Date().toISOString().slice(0, 10) }
}

/** 生成 markdown 报告 */
function renderReport(
  meta: { commit: string; corpusDate: string; runDate: string },
  stats: GroupStat[],
  byType: Record<string, GroupStat[]>,
  refusalRows: Array<{ qid: string; question: string; top1Doc: string; top1Score: number; hitCount: number }>,
  embeddingTokens: number,
  totalQueries: number,
  scopeNote: string,
): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`

  const lines: string[] = []
  lines.push('# RAG 评测报告（三组消融）')
  lines.push('')
  lines.push('> 复现信息（30-评测/01 §4 要求写死）')
  lines.push('')
  lines.push(`- commit：\`${meta.commit}\``)
  lines.push(`- 语料采集日期：\`${meta.corpusDate}\``)
  lines.push(`- 运行日期：\`${meta.runDate}\``)
  lines.push(`- 题目规模：${totalQueries} 题（golden 集 100 题 ${scopeNote}）`)
  lines.push('')
  lines.push('## 1. 总表（三组消融 · 非拒答题）')
  lines.push('')
  lines.push('| 组 | 题数 | Recall@5 | Recall@10 | MRR@10 | P50 延迟 | P95 延迟 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const s of stats) {
    lines.push(`| ${s.channel} | ${s.total} | ${pct(s.recallAt5)} | ${pct(s.recallAt10)} | ${s.mrr10.toFixed(3)} | ${s.p50Ms}ms | ${s.p95Ms}ms |`)
  }
  lines.push('')
  lines.push('## 2. 分题型（Recall@10 / MRR@10）')
  lines.push('')
  lines.push('| 题型 | 组 | 题数 | Recall@10 | MRR@10 |')
  lines.push('|---|---|---|---|---|')
  for (const [type, groupStats] of Object.entries(byType)) {
    for (const s of groupStats) {
      lines.push(`| ${type} | ${s.channel} | ${s.total} | ${pct(s.recallAt10)} | ${s.mrr10.toFixed(3)} |`)
    }
  }
  lines.push('')
  lines.push('## 3. 拒答陷阱题（检索层）')
  lines.push('')
  lines.push('> 陷阱题 goldKeywords 为空 无关键词可命中 检索层「拒答」靠返回相关但不含答案的片段体现')
  lines.push('> 生成层拒答（回答含「无法回答」类表述）在 demo:scenario 端到端补测（LLM-judge）')
  lines.push('> rrfScore 是名次折算分（单路命中 ~0.0167 双路榜首 ~0.033）量级天然偏小 不构成「低分阈值」')
  lines.push('')
  lines.push('| 题 | 问题 | 首条来源 | 首条 rrfScore | 返回条数 |')
  lines.push('|---|---|---|---|---|')
  for (const r of refusalRows) {
    lines.push(`| ${r.qid} | ${r.question} | ${r.top1Doc} | ${r.top1Score.toFixed(4)} | ${r.hitCount} |`)
  }
  lines.push('')
  lines.push('## 4. 成本与延迟')
  lines.push('')
  lines.push(`- 查询 embedding token 合计：${embeddingTokens}（bge-m3 免费 成本 ¥0.00）`)
  lines.push(`- 总检索次数：${totalQueries} 次 × 3 组 = ${totalQueries * 3} 次`)
  lines.push('')
  lines.push('## 5. 规模与局限（诚实条款）')
  lines.push('')
  lines.push('- 题量 100 题（40 单跳 + 30 多跳 + 20 数值 + 10 拒答）个人项目量级 非生产 benchmark')
  lines.push('- gold 用关键词命中近似（chunk 级人工标注过重）偏差方向：**偏乐观（高估真实 chunk 级召回）**——chunk 含关键词未必含完整答案 反之关键词写法不一致时也有少量低估')
  lines.push('- 单一语料域（电商平台规则/法规）结论不可外推到其它领域')
  lines.push('- 两组数字差异 <2pp 时如实写「不显著」不粉饰')
  lines.push('- 检索层确定性：词法/向量分库查询在相同语料与密钥下应完全一致 重跑差异只可能来自 embedding 上游')
  lines.push('')
  return lines.join('\n')
}

async function main(): Promise<void> {
  // 冒烟开关：EVAL_SMOKE=1 只跑 5 题（先冒烟再全量）
  const smoke = process.env.EVAL_SMOKE === '1'
  const smokeCount = 5

  const { prisma, redis, gateway, retrieval, chunks } = await buildDemoServices()

  // 定位 demo 企业与知识库（prisma/seed.ts 已建）
  const enterprise = await prisma.enterprise.findUniqueOrThrow({ where: { slug: 'haowu-yanxuan' } })
  const dataset = await prisma.knowledgeDataset.findFirst({
    where: { enterpriseId: enterprise.id, name: '规则知识库' },
  })
  if (!dataset) throw new Error('demo 知识库未找到 先 pnpm db:seed')

  const ownerMember = await prisma.member.findFirst({ where: { enterpriseId: enterprise.id, role: 'OWNER' } })

  // 语料入库（幂等 已 INDEXED 直接缓存复用）
  console.log('[eval] 语料入库中 ...')
  const ingestRes = await ingestCorpus({
    prisma,
    gateway,
    chunks,
    enterpriseId: enterprise.id,
    datasetId: dataset.id,
    memberId: ownerMember?.id ?? 0,
    corpusDir: path.join(REPO_ROOT, 'corpus'),
  })
  console.log(`[eval] 语料入库完成 文件=${ingestRes.files} 新建=${ingestRes.created} 缓存=${ingestRes.cached} chunks=${ingestRes.chunks}`)

  // 查询 embedding token 基线（跑批后再取增量 计量仅算本次查询向量）
  const baseTokens = await sumEmbeddingTokens(prisma)

  // 加载 golden 并决定冒烟/全量
  const all = loadGolden(path.join(REPO_ROOT, 'corpus'))
  const questions = smoke ? all.slice(0, smokeCount) : all

  console.log(`[eval] ${smoke ? `冒烟 ${questions.length} 题` : `全量 ${questions.length} 题`} 三组消融开跑`)

  const allResults: QueryResult[] = []
  for (const channel of CHANNELS) {
    for (const q of questions) {
      const r = await runQuery(retrieval, enterprise.id, q, channel)
      allResults.push(r)
      process.stdout.write(`[eval] ${channel} ${q.id} recall@10=${r.recallAt10} ${r.latencyMs}ms\n`)
    }
  }

  // 分题型聚合
  const nonRefusal = questions.filter(q => !q.refuse)
  const stats: GroupStat[] = CHANNELS.map(c => aggregate(allResults.filter(r => nonRefusal.some(q => q.id === r.qid)), c))

  const byType: Record<string, GroupStat[]> = {}
  for (const type of ['single_hop', 'multi_hop', 'numeric'] as const) {
    const ids = new Set(nonRefusal.filter(q => q.type === type).map(q => q.id))
    byType[type] = CHANNELS.map(c => aggregate(allResults.filter(r => ids.has(r.qid)), c))
  }

  // 拒答题：记录 auto 组首条来源与分数
  const refusalRows: Array<{ qid: string; question: string; top1Doc: string; top1Score: number; hitCount: number }> = []
  for (const q of questions.filter(q => q.refuse)) {
    const r = allResults.find(x => x.qid === q.id && x.channel === 'auto')
    const top1 = r?.hits[0]
    refusalRows.push({
      qid: q.id,
      question: q.question.slice(0, 40),
      top1Doc: top1?.headingPath ?? (top1 ? `#${top1.docId}` : '-'),
      top1Score: top1?.rrfScore ?? 0,
      hitCount: r?.hits.length ?? 0,
    })
  }

  // 本次查询 embedding token 增量
  const afterTokens = await sumEmbeddingTokens(prisma)
  const embeddingTokens = Math.max(0, afterTokens - baseTokens)

  const meta = collectMeta()
  const scopeNote = smoke ? `仅冒烟前 ${smokeCount} 题` : '全量'

  const report = renderReport(meta, stats, byType, refusalRows, embeddingTokens, questions.length, scopeNote)

  const outPath = path.join(REPO_ROOT, 'docs', '08-阶段总结', '评测报告-RAG.md')
  fs.writeFileSync(outPath, report, 'utf8')

  console.log('\n[eval] 三组消融总表：')
  for (const s of stats) {
    console.log(`  ${s.channel}: Recall@5=${(s.recallAt5 * 100).toFixed(1)}% Recall@10=${(s.recallAt10 * 100).toFixed(1)}% MRR@10=${s.mrr10.toFixed(3)} P95=${s.p95Ms}ms`)
  }
  console.log(`[eval] 查询 embedding token=${embeddingTokens} 成本=¥0.00(bge-m3 免费)`)
  console.log(`[eval] 报告已写入 ${outPath}`)

  await redis.quit()
  await prisma.$disconnect()
}

/** 汇总 usage_records 的 EMBEDDING token 数 用作计量基线/增量 */
async function sumEmbeddingTokens(prisma: PrismaService): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ tokens: bigint }>>`
    SELECT COALESCE(SUM("inputTokens"), 0) AS tokens FROM usage_records WHERE kind = 'EMBEDDING'
  `
  return Number(rows[0]?.tokens ?? 0n)
}

main().catch(e => {
  console.error(`[eval] 失败: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
  process.exit(1)
})
