import { Injectable } from '@nestjs/common'
import type { ModelMessage } from 'ai'
import type { TenantCtx } from '@agent-rag/shared'
import { ModelRouter } from './model-router'
import { BudgetGuard } from './budget-guard'

/** 一次模型调用的用量事实（计量入账后返回给调用方） */
export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  providerName: string // 实际命中的 provider 如 deepseek
  model: string        // 实际上游模型名
  routeAlias: string   // 请求时的逻辑别名
}

/** 流式对话结果 文本增量流 + 完成时的用量 Promise */
export interface GatewayStream {
  textStream: AsyncIterable<string>
  usage: Promise<UsageInfo>
}

/**
 * 网关服务 契约实现（签名见 10-骨架/04 §2）
 * 只做两件事：预算校验 + 委托路由降级 真实逻辑在 ModelRouter
 */
@Injectable()
export class GatewayService {
  constructor(
    private readonly router: ModelRouter,
    private readonly budget: BudgetGuard,
  ) {}

  /** 非流式对话（粗活场景 判分/改写等） */
  async chat(opts: {
    messages: ModelMessage[]
    alias: string
    ctx?: TenantCtx
    temperature?: number
  }): Promise<{ text: string; usage: UsageInfo }> {
    await this.budget.assertWithinBudget(opts.ctx?.enterpriseId)
    return this.router.chat(opts)
  }

  /** 流式对话（Runtime 的主对话链路） */
  async chatStream(opts: {
    messages: ModelMessage[]
    alias: string
    ctx?: TenantCtx
    temperature?: number
  }): Promise<GatewayStream> {
    await this.budget.assertWithinBudget(opts.ctx?.enterpriseId)
    return this.router.chatStream(opts)
  }

  /** 批量向量化（RAG 入库与查询共用） B 任务消费 */
  async embedMany(texts: string[], ctx?: TenantCtx): Promise<number[][]> {
    await this.budget.assertWithinBudget(ctx?.enterpriseId)
    return this.router.embed(texts, ctx)
  }

  /** embedding 通道健康状态（连续失败进入冷却期为 false） B 的降级信号 */
  embeddingHealthy(): boolean {
    return this.router.isEmbeddingHealthy()
  }
}
