import { z } from 'zod'
import type { SkillDef } from '../skill-executor'

/**
 * ticket_classify 工单轻分类入参
 * ticketText 上限 2000 覆盖常规客服工单描述
 */
export const TicketClassifySchema = z.object({
  ticketText: z.string().min(1).max(2000).describe('工单文本内容'),
})
export type TicketClassifyInput = z.infer<typeof TicketClassifySchema>

/**
 * ticket_classify 技能定义
 * 设计意图：轻量工单分类 走 gateway chat 别名（cheap 档）结构化输出 type urgency policyRef
 * 为什么用结构化输出而非自由文本：下游要根据 type 决定转接规则 必须可解析成枚举
 * zod 解析失败重试 1 次 应对 LLM 偶发的输出漂移
 */
export const TicketClassifyDef: SkillDef = {
  key: 'ticket_classify',
  type: 'BUILTIN_FUNCTION',
  description:
    '对工单文本做轻量分类 返回类型 紧急度 参考政策 用于客服分诊与转接决策',
  inputSchema: TicketClassifySchema,
  riskLevel: 1,
}
