import { z } from 'zod'
import type { SkillDef } from '../skill-executor'

/**
 * operate_ticket 工单操作入参
 * action 三态枚举 refund reject escalate 覆盖工单处理主路径
 */
export const OperateTicketSchema = z.object({
  ticketId: z.string().min(1).describe('工单 id'),
  action: z.enum(['refund', 'reject', 'escalate']).describe('操作 退款 驳回 升级'),
  note: z.string().max(500).optional().describe('操作备注 可空'),
})
export type OperateTicketInput = z.infer<typeof OperateTicketSchema>

/**
 * operate_ticket 技能定义
 * 设计意图：对工单执行写操作 调外部系统 /tickets/:id/operate 端点
 * riskLevel=2 写操作 执行成功必须记 SKILL_WRITE 审计事件 外部副作用可追溯
 */
export const OperateTicketDef: SkillDef = {
  key: 'operate_ticket',
  type: 'HTTP_RPA',
  description: '对工单执行退款 驳回 升级操作 写操作 会记录审计事件',
  inputSchema: OperateTicketSchema,
  riskLevel: 2,
}
