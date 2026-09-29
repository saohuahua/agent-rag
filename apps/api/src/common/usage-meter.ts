import type { TenantCtx } from '@agent-rag/shared'

/**
 * 算力账本统一入口（契约定义 A 任务在 gateway/usage-meter.service.ts 实现）
 * 所有耗资源调用（LLM/EMBEDDING/RPA/EXTERNAL_AGENT）必须记账
 * LLM/embedding 由 GatewayService 内部记 C/H 只对 RPA 与外部 agent 显式调用
 */
export interface UsageMeter {
  record(entry: {
    kind: 'LLM' | 'EMBEDDING' | 'RPA' | 'EXTERNAL_AGENT'
    routeAlias: string
    providerName: string
    model: string
    inputTokens?: number
    outputTokens?: number
    /** Decimal 序列化后的数字 RPA 类无 token 时只记成本与耗时 */
    costCny: number
    latencyMs: number
    success: boolean
    errorCode?: string
    /** 计量归属 有租户上下文则记入该企业 */
    ctx?: TenantCtx
    sessionId?: number
  }): Promise<void>
}
