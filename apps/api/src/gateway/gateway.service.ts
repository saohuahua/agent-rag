import { Injectable } from '@nestjs/common'
import type { ModelMessage } from 'ai'
import type { TenantCtx } from '@agent-rag/shared'

/** 一次模型调用的用量事实（计量入账后返回给调用方） */
export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  providerName: string
  model: string
  routeAlias: string
}

/** 流式对话结果：文本增量流 + 完成时的用量 Promise */
export interface GatewayStream {
  textStream: AsyncIterable<string>
  usage: Promise<UsageInfo>
}

/**
 * [桩] 任务 A 将替换本文件为真实现 保持导出名与方法签名不变（契约见 10-骨架/04 §2）
 * 所有方法先抛 NOT_IMPLEMENTED 保证其他任务可编译可联调错误清晰
 */
@Injectable()
export class GatewayService {
  /** 非流式对话（粗活场景 判分/改写等） */
  async chat(opts: {
    messages: ModelMessage[]
    alias: string
    ctx?: TenantCtx
    temperature?: number
  }): Promise<{ text: string; usage: UsageInfo }> {
    throw new Error('NOT_IMPLEMENTED: gateway.chat (任务A)')
  }

  /** 流式对话（Runtime 的主对话链路） */
  async chatStream(opts: {
    messages: ModelMessage[]
    alias: string
    ctx?: TenantCtx
    temperature?: number
  }): Promise<GatewayStream> {
    throw new Error('NOT_IMPLEMENTED: gateway.chatStream (任务A)')
  }

  /** 批量向量化（RAG 入库与查询共用） */
  async embedMany(texts: string[], ctx?: TenantCtx): Promise<number[][]> {
    throw new Error('NOT_IMPLEMENTED: gateway.embedMany (任务A)')
  }

  /** embedding 通道健康状态（连续失败进入冷却期为 false）B 的降级信号 */
  embeddingHealthy(): boolean {
    return false
  }
}
