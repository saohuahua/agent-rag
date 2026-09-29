import { Injectable } from '@nestjs/common'
import type { ModelMessage } from 'ai'
import { RetrievalService } from '../rag/retrieval.service'

/** 历史消息最小形态 由上层从 ConversationMessage 归约而来 */
export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 上下文组装输入 */
export interface BuildContextInput {
  /** 企业 id 用于 INJECT 检索的租户隔离 */
  enterpriseId: number
  /** 员工模板 system prompt（设计意图见种子 禁改） */
  systemPrompt: string
  /** 模板是否带 INJECT/BOTH 知识库绑定 为真则检索 top-3 拼入 system */
  kbInject: boolean
  /** 本轮用户消息 作为 INJECT 检索的 query */
  query: string
  /** 会话消息史（旧→新） */
  history: HistoryMessage[]
  /** 工具清单说明（每个技能一句 进 system prompt 供 LLM 知晓能力边界） */
  toolDescriptions: string[]
  /** 消息史超过上限被截断时回调 用于发截断事件 */
  onTruncate?: (dropped: number) => void
}

/** 组装结果 */
export interface BuiltContext {
  system: string
  messages: ModelMessage[]
}

/** 消息史上限 超过保留最近 40 条（截断记事件） */
const HISTORY_LIMIT = 40

/**
 * 上下文组装：system（模板 + KB INJECT + 工具清单）+ 消息史（截断）
 * 为什么 INJECT 走检索而不是全量：知识库可能很大 只把与当前问题最相关的 top-3
 * 拼进 system 控制 token 又保证引用原文（TOOL 模式下由 kb_search 工具按需取）
 */
@Injectable()
export class ContextBuilder {
  constructor(private readonly retrieval: RetrievalService) {}

  /**
   * 组装一次 turn 的上下文
   * @param input 见 BuildContextInput
   * @returns system 提示词与消息数组（不含当前用户消息 由调用方追加或直接作为 query 已注入）
   */
  async build(input: BuildContextInput): Promise<BuiltContext> {
    const system = await this.buildSystem(input)
    const messages = this.buildHistory(input)

    return { system, messages }
  }

  /** system 三段：模板 prompt + INJECT 检索片段 + 工具清单说明 */
  private async buildSystem(input: BuildContextInput): Promise<string> {
    const parts: string[] = [input.systemPrompt]

    // INJECT：KbMode 含 INJECT 时检索 top-3 拼入 让回答有据可依
    if (input.kbInject) {
      const hits = await this.retrieval.hybridSearch({
        enterpriseId: input.enterpriseId,
        query: input.query,
        topK: 3,
        channel: 'auto',
      })

      if (hits.length > 0) {
        const chunks = hits.map((h, i) => `[${i + 1}] ${h.content}`).join('\n')
        parts.push(`【知识库检索结果 只依据这些片段回答并引用编号】\n${chunks}`)
      }
    }

    // 工具清单说明 帮助 LLM 在恰当场景调用对应工具
    if (input.toolDescriptions.length > 0) {
      const list = input.toolDescriptions.map((d, i) => `${i + 1}. ${d}`).join('\n')
      parts.push(`【可用工具】\n${list}`)
    }

    return parts.join('\n\n')
  }

  /** 消息史归约 + 截断（保留最近 HISTORY_LIMIT 条） */
  private buildHistory(input: BuildContextInput): ModelMessage[] {
    const history = input.history

    // 超过上限截断 保留最近 40 条 丢弃的条数回调给上层记事件
    if (history.length > HISTORY_LIMIT) {
      const dropped = history.length - HISTORY_LIMIT
      input.onTruncate?.(dropped)
      return history.slice(dropped).map(toModelMessage)
    }

    return history.map(toModelMessage)
  }
}

/** 历史消息转 AI SDK ModelMessage 结构 */
function toModelMessage(msg: HistoryMessage): ModelMessage {
  return { role: msg.role, content: msg.content }
}
