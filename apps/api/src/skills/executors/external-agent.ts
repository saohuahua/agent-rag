import { Injectable } from '@nestjs/common'
import type { ModelMessage } from 'ai'
import { GatewayService } from '../../gateway/gateway.service'
import { UsageMeterService } from '../../gateway/usage-meter.service'
import type { SkillCtx, SkillResult } from '../skill-executor'
import type { ConsultCreativeAgentInput } from '../defs/consult-creative-agent'

/**
 * 创意专家 system prompt 设计意图：单轮独立小 agent 的固定角色设定
 * 只输出方案正文 不做多余寒暄 便于直接作为创意方案文本交付
 */
const SYSTEM_PROMPT = [
  '你是一名资深电商营销创意专家 擅长活动策划 文案创意 与转化率优化',
  '根据用户给到的需求简报 输出一份可直接落地的创意方案',
  '方案要结构清晰 包含 核心创意点 执行要点 预期效果 三部分',
].join('\n')

/**
 * 组装会话摘要上下文
 * 为什么只注入 sessionId employeeId templateSlug：SkillCtx 只携带这些会话事实
 * 更丰富的会话摘要需 runtime 在集成期通过 configJson 注入
 * @param ctx 技能执行上下文
 */
function buildSessionContext(ctx: SkillCtx): string {
  const parts = [
    `sessionId=${ctx.sessionId}`,
    `employeeId=${ctx.employeeId}`,
    `template=${ctx.templateSlug}`,
  ]
  return parts.join(' ')
}

/**
 * EXTERNAL_AGENT 执行器 经 gateway strong-chat 别名起独立小 agent
 * 这是「外部 agent」的最小真实形态：单轮 system 角色 + 会话上下文注入
 * 为什么走 gateway 而非直连外部端点：strong-chat 别名已承载降级链与 LLM 计量 复用同一套基础设施
 */
@Injectable()
export class ExternalAgentExecutor {
  constructor(
    private readonly gateway: GatewayService,
    private readonly meter: UsageMeterService,
  ) {}

  /**
   * 执行创意咨询
   * @param input 已过 zod 校验的入参
   * @param ctx 技能执行上下文 注入会话摘要并传给网关计量
   */
  async run(input: ConsultCreativeAgentInput, ctx: SkillCtx): Promise<SkillResult> {
    const context = buildSessionContext(ctx)
    const messages: ModelMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `会话上下文：${context}\n\n创意需求：${input.brief}` },
    ]

    const started = Date.now()
    const { text, usage } = await this.gateway.chat({
      messages,
      alias: 'strong-chat',
      ctx: ctx.ctx,
    })
    const latencyMs = Date.now() - started

    // EXTERNAL_AGENT 计量 成本记 0 但调用量与延迟真实 未来接真实外部 agent 端点时改这里
    // 底层 LLM 的 token 成本已由 gateway 内部按 kind=LLM 记 此处记的是「外部调用次数」账
    await this.meter.record({
      kind: 'EXTERNAL_AGENT',
      routeAlias: 'strong-chat',
      providerName: usage.providerName,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costCny: 0,
      latencyMs,
      success: true,
      ctx: ctx.ctx,
      sessionId: ctx.sessionId,
    })

    return {
      output: { plan: text },
      summary: '创意方案已生成',
    }
  }
}
