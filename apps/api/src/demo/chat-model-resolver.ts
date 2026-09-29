import type { LanguageModel } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { PrismaService } from '../prisma/prisma.service'
import type { EnvService } from '../config/env.service'
import type { ChatModelResolver } from '../runtime/agent-model'

/**
 * demo 集成用的真实 chat 模型解析器（Runtime 工具循环需要 LanguageModel）
 * 为什么存在：GatewayService 契约（10-骨架/04 §2）只暴露 chat/chatStream 不暴露「取模型实例」
 *   Runtime 工具循环必须自调 AI SDK streamText 并传 tools 只能拿 LanguageModel
 *   C 任务已在 runtime.module.ts 里留 NOT_IMPLEMENTED 桩 契约变更提案建议 GatewayService 增加 resolveChatModel
 * 边界遵守：本实现放在 demo/（J 任务目录）不直改 gateway 与 runtime 目录
 * 为什么是普通类手动 new 而非 @Injectable：demo 脚本用 tsx 直跑 esbuild 不产出 design:paramtypes
 *   Nest DI 在 tsx 下无法解析构造参数 故整个 demo 上下文改为手动装配（见 bootstrap.ts）
 * 局限（诚实标注）：只做「第一条可用路由」解析 不做降级链/健康/预算/计量
 *   完整降级链在网关 ModelRouter 内部 本 resolver 是集成期的最小等价物 契约落定后应删掉并一行委托 gateway
 */
export class DemoChatModelResolver implements ChatModelResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  /**
   * 按 alias 解析一个可流式 chat 模型
   * @param alias 逻辑别名 如 chat strong-chat
   * @returns AI SDK LanguageModel 供 streamText 使用
   */
  async resolve(alias: string): Promise<LanguageModel> {
    // 读 alias 降级链 按 priority 升序 找第一条密钥已配置的 provider
    const routes = await this.prisma.modelRoute.findMany({
      where: { alias, enabled: true, provider: { enabled: true } },
      orderBy: { priority: 'asc' },
      include: { provider: true },
    })

    for (const r of routes) {
      const apiKey = this.readApiKey(r.provider.apiKeyEnv)
      if (!apiKey) continue

      // createOpenAICompatible 与网关 ProviderRegistry 同款 密钥经 EnvService 读
      // includeUsage 必须开 否则流式 usage 拿不到 计账与排空背压依赖它
      const provider = createOpenAICompatible({
        name: r.provider.name,
        baseURL: r.provider.baseUrl,
        apiKey,
        includeUsage: true,
      })
      return provider.chatModel(r.upstreamModel)
    }

    throw new Error(`no available chat model for alias=${alias}`)
  }

  /** 环境变量名 → EnvService getter 映射（与网关 ProviderRegistry 对齐） */
  private readApiKey(envName: string): string {
    if (envName === 'DEEPSEEK_API_KEY') return this.env.DEEPSEEK_API_KEY
    if (envName === 'SILICONFLOW_API_KEY') return this.env.SILICONFLOW_API_KEY
    return ''
  }
}
