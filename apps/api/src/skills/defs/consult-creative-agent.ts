import { z } from 'zod'
import type { SkillDef } from '../skill-executor'

/**
 * consult_creative_agent 创意咨询入参
 * brief 上限 2000 覆盖营销创意需求简报
 */
export const ConsultCreativeAgentSchema = z.object({
  brief: z.string().min(1).max(2000).describe('创意需求简报'),
})
export type ConsultCreativeAgentInput = z.infer<typeof ConsultCreativeAgentSchema>

/**
 * consult_creative_agent 技能定义
 * 设计意图：经 gateway 以 strong-chat 别名起一个独立小 agent 单轮 system 创意角色
 * 注入会话摘要上下文（sessionId employeeId templateSlug） 这是「外部 agent」的最小真实形态
 * 为什么走 gateway 而非直连外部端点：strong-chat 别名已承载降级与计量 复用同一套路由链
 */
export const ConsultCreativeAgentDef: SkillDef = {
  key: 'consult_creative_agent',
  type: 'EXTERNAL_AGENT',
  description: '咨询创意专家 agent 输入需求简报 返回创意方案文本 用于营销文案与活动策划',
  inputSchema: ConsultCreativeAgentSchema,
  riskLevel: 1,
}
