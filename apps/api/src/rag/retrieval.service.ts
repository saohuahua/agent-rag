import { Injectable } from '@nestjs/common'
import type { RetrievalHit } from '@agent-rag/shared'

/**
 * [桩] 任务 B 将替换本文件为真实现（契约见 10-骨架/04 §4）
 * 双路混合检索：向量路与词法路并行 RRF 融合 embedding 不健康时自动降级纯词法
 */
@Injectable()
export class RetrievalService {
  /**
   * 混合检索
   * @param opts.channel auto=双路+降级 vector/lexical=单路（评测消融用）
   */
  async hybridSearch(opts: {
    enterpriseId: number
    query: string
    topK?: number
    channel?: 'auto' | 'vector' | 'lexical'
  }): Promise<RetrievalHit[]> {
    throw new Error('NOT_IMPLEMENTED: retrieval.hybridSearch (任务B)')
  }
}
