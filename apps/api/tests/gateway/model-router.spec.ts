import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APICallError, embedMany, generateText, streamText } from 'ai'
import { Prisma } from '../../src/generated/prisma/client'
import { ModelRouter } from '../../src/gateway/model-router'
import { HealthTracker } from '../../src/gateway/health-tracker'
import type { PrismaService } from '../../src/prisma/prisma.service'
import type { ProviderRegistry } from '../../src/gateway/provider-registry'
import type { UsageMeterService } from '../../src/gateway/usage-meter.service'
import type { EmbeddingModel, LanguageModel, ModelMessage } from 'ai'

// 只 mock AI SDK 的三个生成函数 其余导出（APICallError 等）保持真实
vi.mock('ai', async importOriginal => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: vi.fn(), streamText: vi.fn(), embedMany: vi.fn() }
})

/** 测试消息 角色字面量收窄为合法 ModelMessage */
const userMsg = (content: string): ModelMessage => ({ role: 'user', content })

/** 构造一条 DB 路由行 fixture 供 findMany mock 返回 */
function makeRoute(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    alias: 'chat',
    providerId: 1,
    upstreamModel: 'deepseek-flash',
    priority: 10,
    priceInPerMTok: new Prisma.Decimal(1),
    priceOutPerMTok: new Prisma.Decimal(4),
    enabled: true,
    provider: { id: 1, name: 'deepseek', enabled: true },
    ...over,
  }
}

/** 组装 router 及其依赖 mock 每个 provider 返回可标记模型便于断言命中哪一跳 */
function createRouter(routes: unknown[]) {
  const prisma = {
    modelRoute: { findMany: vi.fn().mockResolvedValue(routes) },
    usageRecord: { create: vi.fn().mockResolvedValue({}), aggregate: vi.fn().mockResolvedValue({ _sum: { costCny: null } }) },
    enterprise: { findUnique: vi.fn().mockResolvedValue(null) },
  }
  const providers = { getBundle: vi.fn() }
  const meter = { record: vi.fn().mockResolvedValue(undefined) }
  const health = new HealthTracker()

  providers.getBundle.mockImplementation(async (providerId: number) => ({
    chatModel: (modelId: string) => ({ tag: `chat:${providerId}:${modelId}` } as unknown as LanguageModel),
    embeddingModel: (modelId: string) => ({ tag: `emb:${providerId}:${modelId}` } as unknown as EmbeddingModel),
  }))

  const router = new ModelRouter(
    prisma as unknown as PrismaService,
    providers as unknown as ProviderRegistry,
    health,
    meter as unknown as UsageMeterService,
  )

  return { router, prisma, providers, meter, health }
}

/** generateText mock 的成功返回 只含 router 需要的字段 */
function okText(text: string, inputTokens: number, outputTokens: number) {
  return { text, usage: { inputTokens, outputTokens } } as unknown as Awaited<ReturnType<typeof generateText>>
}

describe('ModelRouter 路由解析与降级', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('第一跳 5xx 自动降级第二跳 记账两条一失败一成功', async () => {
    const routes = [
      makeRoute({ id: 1, providerId: 1, provider: { name: 'deepseek' } }),
      makeRoute({ id: 2, providerId: 2, provider: { name: 'siliconflow' }, upstreamModel: 'Qwen3-8B', priority: 20 }),
    ]
    const { router, meter } = createRouter(routes)

    vi.mocked(generateText)
      .mockRejectedValueOnce(new APICallError({ message: 'upstream 500', url: 'http://x', requestBodyValues: {}, statusCode: 500 }))
      .mockResolvedValueOnce(okText('你好', 10, 20))

    const result = await router.chat({ messages: [userMsg('hi')], alias: 'chat' })

    expect(result.text).toBe('你好')
    expect(generateText).toHaveBeenCalledTimes(2)
    // 第二跳命中 siliconflow 的模型
    expect(vi.mocked(generateText).mock.calls[1]?.[0].model).toEqual({ tag: 'chat:2:Qwen3-8B' })
    // 记账两条 先失败后成功
    expect(meter.record).toHaveBeenCalledTimes(2)
    expect(meter.record).toHaveBeenNthCalledWith(1, expect.objectContaining({ success: false, providerName: 'deepseek' }))
    expect(meter.record).toHaveBeenNthCalledWith(2, expect.objectContaining({ success: true, providerName: 'siliconflow', inputTokens: 10, outputTokens: 20 }))
  })

  it('鉴权 401（key 改错）可降级到下一跳', async () => {
    const routes = [
      makeRoute({ id: 1, providerId: 1 }),
      makeRoute({ id: 2, providerId: 2, upstreamModel: 'Qwen3-8B' }),
    ]
    const { router, meter } = createRouter(routes)

    vi.mocked(generateText)
      .mockRejectedValueOnce(new APICallError({ message: 'invalid api key', url: 'http://x', requestBodyValues: {}, statusCode: 401 }))
      .mockResolvedValueOnce(okText('ok', 3, 4))

    const result = await router.chat({ messages: [userMsg('hi')], alias: 'chat' })

    expect(result.text).toBe('ok')
    expect(generateText).toHaveBeenCalledTimes(2)
    expect(meter.record).toHaveBeenCalledTimes(2)
  })

  it('参数类 4xx（400）不换路直接抛 且不记账', async () => {
    const routes = [makeRoute({ id: 1, providerId: 1 }), makeRoute({ id: 2, providerId: 2 })]
    const { router, meter } = createRouter(routes)

    vi.mocked(generateText).mockRejectedValueOnce(
      new APICallError({ message: 'bad request', url: 'http://x', requestBodyValues: {}, statusCode: 400 }),
    )

    await expect(router.chat({ messages: [userMsg('hi')], alias: 'chat' })).rejects.toThrow()
    expect(generateText).toHaveBeenCalledTimes(1)
    expect(meter.record).not.toHaveBeenCalled()
  })

  it('provider 不可用（key 未配置）跳过该跳', async () => {
    const routes = [makeRoute({ id: 1, providerId: 1 }), makeRoute({ id: 2, providerId: 2, upstreamModel: 'Qwen3-8B' })]
    const { router, providers } = createRouter(routes)

    // 第一跳 provider 返回 null 表示不可用 应被跳过
    providers.getBundle.mockImplementation(async (pid: number) =>
      pid === 1
        ? null
        : ({ chatModel: (id: string) => ({ tag: id } as unknown as LanguageModel), embeddingModel: (id: string) => ({ tag: id } as unknown as EmbeddingModel) }),
    )

    vi.mocked(generateText).mockResolvedValueOnce(okText('ok', 1, 1))
    await router.chat({ messages: [userMsg('hi')], alias: 'chat' })

    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('处于冷却期的跳位被过滤 直接走下一跳', async () => {
    const routes = [makeRoute({ id: 1, providerId: 1 }), makeRoute({ id: 2, providerId: 2, upstreamModel: 'Qwen3-8B' })]
    const { router, health } = createRouter(routes)

    // 提前把第一跳打进冷却期 键名与 resolveHops 生成一致
    health.recordFailure('chat:deepseek/deepseek-flash')
    health.recordFailure('chat:deepseek/deepseek-flash')
    health.recordFailure('chat:deepseek/deepseek-flash')

    vi.mocked(generateText).mockResolvedValueOnce(okText('ok', 1, 1))
    await router.chat({ messages: [userMsg('hi')], alias: 'chat' })

    expect(generateText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(generateText).mock.calls[0]?.[0].model).toEqual({ tag: 'chat:2:Qwen3-8B' })
  })
})

describe('ModelRouter 计量', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('价格换算正确 1M 入 + 1M 出 价格 1/4 得 5 元', async () => {
    const routes = [makeRoute({ id: 1, providerId: 1, priceInPerMTok: new Prisma.Decimal(1), priceOutPerMTok: new Prisma.Decimal(4) })]
    const { router, meter } = createRouter(routes)

    vi.mocked(generateText).mockResolvedValueOnce(okText('ok', 1_000_000, 1_000_000))

    const result = await router.chat({ messages: [userMsg('x')], alias: 'chat' })

    expect(result.costCny).toBe(5)
    expect(meter.record).toHaveBeenCalledWith(expect.objectContaining({ success: true, costCny: 5 }))
  })
})

describe('ModelRouter 流式降级', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('建立流时网络错自动降级下一跳', async () => {
    const routes = [
      makeRoute({ id: 1, providerId: 1 }),
      makeRoute({ id: 2, providerId: 2, provider: { name: 'siliconflow' }, upstreamModel: 'Qwen3-8B' }),
    ]
    const { router, meter } = createRouter(routes)

    // 第一跳 textStream 首次 next 抛网络错 第二跳正常出两段
    vi.mocked(streamText)
      .mockReturnValueOnce({
        textStream: { [Symbol.asyncIterator]() { return { next: () => Promise.reject(new Error('ECONNREFUSED')) } } },
      } as unknown as ReturnType<typeof streamText>)
      .mockReturnValueOnce({
        textStream: (async function* () { yield '你'; yield '好' })(),
        usage: Promise.resolve({ inputTokens: 3, outputTokens: 4 }),
      } as unknown as ReturnType<typeof streamText>)

    const stream = await router.chatStream({ messages: [userMsg('hi')], alias: 'chat' })
    const chunks: string[] = []
    for await (const c of stream.textStream) chunks.push(c)
    await stream.usage

    expect(chunks).toEqual(['你', '好'])
    expect(meter.record).toHaveBeenCalledTimes(2)
    expect(meter.record).toHaveBeenNthCalledWith(1, expect.objectContaining({ success: false, providerName: 'deepseek' }))
    expect(meter.record).toHaveBeenNthCalledWith(2, expect.objectContaining({ success: true, providerName: 'siliconflow', inputTokens: 3, outputTokens: 4 }))
  })
})

describe('ModelRouter embedding 健康', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('连续 3 次 embedding 失败进入冷却 embeddingHealthy 返回 false', async () => {
    const routes = [makeRoute({ id: 1, alias: 'embedding', providerId: 1, provider: { name: 'siliconflow' }, upstreamModel: 'bge-m3' })]
    const { router } = createRouter(routes)

    vi.mocked(embedMany).mockRejectedValue(new Error('ECONNREFUSED'))

    for (let i = 0; i < 3; i++) {
      await expect(router.embed(['x'])).rejects.toThrow()
    }

    expect(router.isEmbeddingHealthy()).toBe(false)
  })

  it('尚无 embedding 调用时默认健康', async () => {
    const routes = [makeRoute({ id: 1, alias: 'embedding', providerId: 1 })]
    const { router } = createRouter(routes)
    expect(router.isEmbeddingHealthy()).toBe(true)
  })
})
