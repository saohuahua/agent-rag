import { Injectable, Logger } from '@nestjs/common'
import type { RetrievalHit } from '@agent-rag/shared'
import { GatewayService } from '../gateway/gateway.service'
import { ChunkRepository } from './chunk.repository'
import type { VectorRow, LexicalRow } from './chunk.repository'
import { tokenize } from './tokenizer'

/** RRF 融合常数 k=60 Elasticsearch 同款 */
const RRF_K = 60

/** 默认返回条数 */
const DEFAULT_TOPK = 8

/** 参与融合的带名次命中 名次由数组顺序隐含 */
export interface RankedHit {
  chunkId: number
  docId: number
  content: string
  headingPath: string | null
  page: number | null
}

/** RRF 融合后的中间结果 */
export interface FusedHit {
  chunkId: number
  docId: number
  content: string
  headingPath: string | null
  page: number | null
  vectorRank?: number
  lexicalRank?: number
  rrfScore: number
}

/**
 * RRF 纯函数 只用排名不用分数
 * 为什么 RRF：两路分数量纲不可比（余弦距离 vs ts_rank）只用名次才可比
 * 为什么在应用层融合而非 SQL：降级语义天然 计算量极小 见 20-规格/02 §3
 * @param vecHits 向量路命中（已按名次排序）
 * @param lexHits 词法路命中（已按名次排序）
 * @param k RRF 常数
 * @returns 融合后按 rrfScore 降序
 */
export function rrfFuse(vecHits: RankedHit[], lexHits: RankedHit[], k = RRF_K): FusedHit[] {
  const map = new Map<number, FusedHit>()

  vecHits.forEach((h, i) => {
    const rank = i + 1
    const e = map.get(h.chunkId) ?? { ...h, rrfScore: 0 }
    e.vectorRank = rank
    e.rrfScore += 1 / (k + rank)
    map.set(h.chunkId, e)
  })

  lexHits.forEach((h, i) => {
    const rank = i + 1
    const e = map.get(h.chunkId) ?? { ...h, rrfScore: 0 }
    e.lexicalRank = rank
    e.rrfScore += 1 / (k + rank)
    map.set(h.chunkId, e)
  })

  return [...map.values()].sort((a, b) => b.rrfScore - a.rrfScore)
}

/**
 * 双路混合检索 契约实现（签名见 10-骨架/04 §4）
 * 向量路与词法路并行 RRF 融合 embedding 不健康或向量路失败时自动降级纯词法
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name)

  constructor(
    private readonly gateway: GatewayService,
    private readonly chunks: ChunkRepository,
  ) {}

  /**
   * 混合检索
   * @param opts.enterpriseId 租户 id
   * @param opts.query 查询文本
   * @param opts.topK 返回条数 默认 8
   * @param opts.channel auto=双路+降级 vector/lexical=单路（评测消融用）
   */
  async hybridSearch(opts: {
    enterpriseId: number
    query: string
    topK?: number
    channel?: 'auto' | 'vector' | 'lexical'
  }): Promise<RetrievalHit[]> {
    const topK = opts.topK ?? DEFAULT_TOPK
    const channel = opts.channel ?? 'auto'

    // 决定各路是否参与 auto 下 embedding 不健康直接跳过向量路 免浪费一次调用
    const useVector = channel === 'vector' || (channel === 'auto' && this.gateway.embeddingHealthy())
    const useLexical = channel !== 'vector'

    // 两路并行 任一路失败不拖垮另一路 由 allSettled 收口
    const [vecRes, lexRes] = await Promise.allSettled([
      useVector ? this.vectorPath(opts.enterpriseId, opts.query) : Promise.resolve<RankedHit[]>([]),
      useLexical ? this.lexicalPath(opts.enterpriseId, opts.query) : Promise.resolve<RankedHit[]>([]),
    ])

    // 解析各路结果 失败降级为空路并记日志
    let vecHits: RankedHit[] = []
    if (vecRes.status === 'fulfilled') {
      vecHits = vecRes.value
    } else if (channel === 'auto') {
      // 向量路失败 auto 通道降级纯词法 这是本模块的灵魂 见 20-规格/02 §4.5
      this.logger.warn('[DEGRADE] embedding unavailable, fallback to lexical')
    } else {
      this.logger.warn(`[DEGRADE] vector path failed in channel=vector: ${errorText(vecRes.reason)}`)
    }

    let lexHits: RankedHit[] = []
    if (lexRes.status === 'fulfilled') {
      lexHits = lexRes.value
    } else {
      this.logger.warn(`[DEGRADE] lexical path failed: ${errorText(lexRes.reason)}`)
    }

    // 单路时 RRF 退化为该路名次折算分 双路时融合
    const fused = rrfFuse(vecHits, lexHits)

    return fused.slice(0, topK).map(f => ({
      chunkId: f.chunkId,
      docId: f.docId,
      content: f.content,
      headingPath: f.headingPath,
      page: f.page,
      vectorRank: f.vectorRank,
      lexicalRank: f.lexicalRank,
      rrfScore: f.rrfScore,
    }))
  }

  /** 向量路：查询向量化 → 近邻检索 */
  private async vectorPath(enterpriseId: number, query: string): Promise<RankedHit[]> {
    const qvecs = await this.gateway.embedMany([query])
    const qvec = qvecs[0]
    if (!qvec) return []
    const rows = await this.chunks.vectorSearch(enterpriseId, qvec)
    return rows.map(toRankedHit)
  }

  /** 词法路：分词 → tsquery 检索 */
  private async lexicalPath(enterpriseId: number, query: string): Promise<RankedHit[]> {
    const tokens = tokenize(query)
    if (tokens.length === 0) return []
    const rows = await this.chunks.lexicalSearch(enterpriseId, tokens)
    return rows.map(toRankedHit)
  }
}

/** 原始行转带名次命中 */
function toRankedHit(row: VectorRow | LexicalRow): RankedHit {
  return {
    chunkId: row.id,
    docId: row.docId,
    content: row.content,
    headingPath: row.headingPath,
    page: row.page,
  }
}

/** 异常转英文描述 供日志 */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
