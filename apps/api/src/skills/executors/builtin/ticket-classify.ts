import { Injectable } from '@nestjs/common'
import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { GatewayService } from '../../../gateway/gateway.service'
import { SkillInputError } from '../../errors'
import type { SkillCtx, SkillResult } from '../../skill-executor'
import type { TicketClassifyInput } from '../../defs/ticket-classify'

/** 分类结果 schema 必须可解析成枚举 供下游转接规则消费 */
const CLASSIFY_SCHEMA = z.object({
  type: z.enum(['refund', 'return', 'delivery', 'quality', 'invoice', 'consult', 'complaint', 'other']),
  urgency: z.enum(['low', 'normal', 'high', 'urgent']),
  policyRef: z.string().min(1).max(300),
})
type ClassifyResult = z.infer<typeof CLASSIFY_SCHEMA>

/**
 * 分类 system prompt 设计意图：约束模型只输出一个 JSON 对象 便于 zod 解析
 * 明确列出 type 与 urgency 枚举 减少模型自由发挥导致的解析失败
 */
const SYSTEM_PROMPT = [
  '你是电商客服工单分类器 请对用户给到的工单文本做轻量分类',
  '只输出一个 JSON 对象 不要输出任何其它文字 不要用 markdown 代码块',
  'JSON 字段：type 取 refund return delivery quality invoice consult complaint other 之一',
  'urgency 取 low normal high urgent 之一 policyRef 用一句话说明依据的平台规则条款或政策名',
].join('\n')

/** 解析失败重试上限 首次 + 重试 1 次 */
const MAX_ATTEMPTS = 2

/**
 * 从 LLM 文本里提取 JSON 对象 兼容 markdown 代码围栏与前后杂文
 * 提取失败不抛异常 返回原始文本 让后续 zod 校验报错 由调用方决定重试
 * @param text 模型原始输出
 */
function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced?.[1] ?? text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return body.trim()

  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return body.trim()
  }
}

/**
 * ticket_classify 执行器 走 gateway chat 别名（cheap 档）结构化输出
 * 为什么只用 cheap 档：工单分类是粗活 不需要强模型 控制成本
 */
@Injectable()
export class TicketClassifyExecutor {
  constructor(private readonly gateway: GatewayService) {}

  /**
   * 执行工单分类
   * @param input 已过 zod 校验的入参
   * @param ctx 技能执行上下文 传租户上下文给网关计量
   */
  async run(input: TicketClassifyInput, ctx: SkillCtx): Promise<SkillResult> {
    const messages: ModelMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: input.ticketText },
    ]

    let lastIssues: unknown = null

    // 解析失败重试 1 次 应对 LLM 结构化输出偶发漂移 每次重试重新生成
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { text } = await this.gateway.chat({
        messages,
        alias: 'chat',
        ctx: ctx.ctx,
      })

      const result = CLASSIFY_SCHEMA.safeParse(extractJsonObject(text))
      if (result.success) {
        const data: ClassifyResult = result.data
        return {
          output: data,
          summary: `工单分类 ${data.type} 紧急度 ${data.urgency} 参考 ${data.policyRef}`,
        }
      }
      lastIssues = result.error.issues
    }

    throw new SkillInputError('ticket_classify structured output parse failed after retry', lastIssues)
  }
}
