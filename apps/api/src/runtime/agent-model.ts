import type { LanguageModel } from 'ai'

/**
 * Agent 工具循环所需的 chat 模型解析器（跨模块契约补丁的落点）
 * 为什么存在：GatewayService 契约只暴露 chat/chatStream（签名无 tools 参数）
 * 而 Runtime 的工具循环必须自调 AI SDK streamText 并传入 tools 故需要拿到 LanguageModel
 * 契约变更提案见 C 报告：建议 GatewayService 新增 resolveChatModel(alias)
 * 届时真实实现改为一行委托 gateway 本接口桩实现删除（集成由 J 做）
 */
export interface ChatModelResolver {
  /** 按路由别名解析一个可流式 chat 模型（降级链/预算/健康由 gateway 侧负责） */
  resolve(alias: string): Promise<LanguageModel>
}

/** DI token 供 turn.processor 注入 单测用假 resolver */
export const CHAT_MODEL_RESOLVER = 'CHAT_MODEL_RESOLVER'
