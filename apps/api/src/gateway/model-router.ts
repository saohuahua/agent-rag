import { Injectable, Logger } from '@nestjs/common'
import { APICallError, embedMany, generateText, streamText } from 'ai'
import type { EmbeddingModel, LanguageModel, ModelMessage } from 'ai'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { ProviderRegistry } from './provider-registry'
import { HealthTracker } from './health-tracker'
import { UsageMeterService } from './usage-meter.service'
import { RouteExhaustedError, EmbeddingDimensionError } from './errors'
import type { GatewayStream, UsageInfo } from './gateway.service'
import type { TenantCtx } from '@agent-rag/shared'

/** bge-m3 固定输出维度 首次调用断言 不符说明上游模型配错 */
const EMBEDDING_DIM = 1024

/** 一次路由尝试的调用参数 */
export interface RouteCallOpts {
  messages: ModelMessage[]
  alias: string
  ctx?: TenantCtx
  temperature?: number
}

/** 一条降级跳位：路由行数据 + 该跳可用的模型实例 */
export interface RouteHop {
  routeId: number
  alias: string
  providerName: string
  upstreamModel: string
  priceInPerMTok: Prisma.Decimal
  priceOutPerMTok: Prisma.Decimal
  chatModel: LanguageModel | null
  embeddingModel: EmbeddingModel | null
  hopKey: string
}

/** 非流式对话结果 在契约基础上附成本供 HTTP 响应展示 */
export interface ChatResult {
  text: string
  usage: UsageInfo
  costCny: number
}

/** 跳位健康键：alias 加 provider/model 一跳一记录 */
function hopKeyOf(alias: string, providerName: string, model: string): string {
  return `${alias}:${providerName}/${model}`
}

/**
 * 判断该错误是否允许换下一跳
 * 为什么 401 例外：鉴权失败是「这家供应商的 key 坏了」换供应商（不同密钥）可解
 * 为什么 429 例外：限流是资源问题 换一家即可解
 * 其余 4xx（参数错/模型不存在）换路一样错 不降级
 * 无 HTTP 状态码（网络断/超时/连接拒绝）视为可降级
 */
function isFailoverable(e: unknown): boolean {
  if (!APICallError.isInstance(e)) return true
  const s = e.statusCode
  if (s === 401 || s === 429) return true
  if (s !== undefined && s >= 400 && s < 500) return false
  return true
}

/** 从异常提取可搜索的英文错误码 落账用 */
function errorCodeOf(e: unknown): string {
  if (APICallError.isInstance(e)) {
    return e.statusCode !== undefined ? `HTTP_${e.statusCode}` : 'API_ERROR'
  }
  if (e instanceof Error) return e.name || 'UNKNOWN'
  return 'UNKNOWN'
}

/** 异常转英文描述 供日志与 RouteExhaustedError 携带 */
function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** 按健康状态过滤跳位 全部冷却时放行全部 避免路由彻底瘫痪 */
function filterByHealth(hops: RouteHop[], health: HealthTracker): RouteHop[] {
  const available = hops.filter(h => !health.isCooling(h.hopKey))
  return available.length > 0 ? available : hops
}

/** 空文本流 上游直接结束（空回复）时占位 */
function emptyTextStream(): AsyncIterable<string> {
  return (async function* () {})()
}

/**
 * 模型路由器：alias → 降级链解析 + 逐跳尝试
 * 为什么每跳不重试：重试语义交给调用方（BullMQ attempts）
 * 降级链本身已是「换资源重试」 跳内再重试只会放大故障
 */
@Injectable()
export class ModelRouter {
  private readonly logger = new Logger(ModelRouter.name)

  /** embedding 全部跳位健康键缓存 供 embeddingHealthy 同步判断 */
  private embeddingHopKeys: string[] = []

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
    private readonly health: HealthTracker,
    private readonly meter: UsageMeterService,
  ) {}

  /**
   * 非流式对话 按降级链逐跳尝试 全部失败抛 RouteExhaustedError
   */
  async chat(opts: RouteCallOpts): Promise<ChatResult> {
    const hops = await this.resolveHops(opts.alias, 'chat')
    let lastError: unknown = null

    for (const hop of hops) {
      const started = Date.now()
      try {
        const result = await generateText({
          model: hop.chatModel as LanguageModel,
          messages: opts.messages,
          temperature: opts.temperature,
          maxRetries: 0,
          // AI SDK v7 默认禁止 messages 带 system 角色 调用方（ticket_classify/external_agent）会传 需放开
          allowSystemInMessages: true,
        })

        const inputTokens = result.usage.inputTokens ?? 0
        const outputTokens = result.usage.outputTokens ?? 0
        const cost = this.computeCost(hop, inputTokens, outputTokens)

        await this.recordSuccess(hop, 'LLM', opts.ctx, inputTokens, outputTokens, cost, Date.now() - started)
        this.health.recordSuccess(hop.hopKey)

        return { text: result.text, usage: this.buildUsageInfo(hop, inputTokens, outputTokens), costCny: cost.toNumber() }
      } catch (e) {
        lastError = e
        if (!isFailoverable(e)) throw e
        this.health.recordFailure(hop.hopKey)
        await this.recordFailure(hop, 'LLM', opts.ctx, e, Date.now() - started)
      }
    }

    throw new RouteExhaustedError(opts.alias, describeError(lastError))
  }

  /**
   * 流式对话 降级发生在建立流阶段（读首分片暴露 401/网络错）
   * 返回后中途断流无法再降级 由调用方兜底
   */
  async chatStream(opts: RouteCallOpts): Promise<GatewayStream> {
    const hops = await this.resolveHops(opts.alias, 'chat')
    let lastError: unknown = null

    for (const hop of hops) {
      const started = Date.now()
      try {
        return await this.establishStream(hop, opts, started)
      } catch (e) {
        lastError = e
        if (!isFailoverable(e)) throw e
        this.health.recordFailure(hop.hopKey)
        await this.recordFailure(hop, 'LLM', opts.ctx, e, Date.now() - started)
      }
    }

    throw new RouteExhaustedError(opts.alias, describeError(lastError))
  }

  /**
   * 批量向量化 走 embedding 别名降级链
   * 首次返回后断言 1024 维 不符视为该通道坏 记健康并抛 EmbeddingDimensionError
   */
  async embed(texts: string[], ctx?: TenantCtx): Promise<number[][]> {
    const hops = await this.resolveHops('embedding', 'embedding')
    let lastError: unknown = null

    for (const hop of hops) {
      const started = Date.now()
      try {
        const result = await embedMany({
          model: hop.embeddingModel as EmbeddingModel,
          values: texts,
          maxRetries: 0,
        })

        const vectors = result.embeddings.map(v => Array.from(v))
        const dim = vectors[0]?.length ?? 0

        if (dim !== EMBEDDING_DIM) {
          const err = new EmbeddingDimensionError(dim)
          this.health.recordFailure(hop.hopKey)
          await this.recordFailure(hop, 'EMBEDDING', ctx, err, Date.now() - started)
          throw err
        }

        const inputTokens = result.usage.tokens
        const cost = this.computeCost(hop, inputTokens, 0)

        await this.recordSuccess(hop, 'EMBEDDING', ctx, inputTokens, 0, cost, Date.now() - started)
        this.health.recordSuccess(hop.hopKey)

        return vectors
      } catch (e) {
        lastError = e
        if (!isFailoverable(e)) throw e
        this.health.recordFailure(hop.hopKey)
        await this.recordFailure(hop, 'EMBEDDING', ctx, e, Date.now() - started)
      }
    }

    throw new RouteExhaustedError('embedding', describeError(lastError))
  }

  /**
   * embedding 通道健康状态 供 B 任务降级信号
   * 规则：全部跳位处于冷却期才算不健康 至少一跳可用即健康
   * 为什么用内存缓存而非同步查库：契约要求同步返回 缓存由 embed 调用时刷新
   */
  isEmbeddingHealthy(): boolean {
    const keys = this.embeddingHopKeys
    if (keys.length === 0) return true
    return keys.some(k => !this.health.isCooling(k))
  }

  /** 解析 alias 降级链：查库按 priority 升序 + 过滤禁用与冷却 */
  private async resolveHops(alias: string, kind: 'chat' | 'embedding'): Promise<RouteHop[]> {
    const routes = await this.prisma.modelRoute.findMany({
      where: { alias, enabled: true, provider: { enabled: true } },
      orderBy: { priority: 'asc' },
      include: { provider: true },
    })

    const hops: RouteHop[] = []

    for (const r of routes) {
      const bundle = await this.providers.getBundle(r.providerId)
      if (!bundle) {
        this.logger.warn(`alias=${alias} 的 provider=${r.provider.name} 不可用 跳过该跳`)
        continue
      }

      hops.push({
        routeId: r.id,
        alias,
        providerName: r.provider.name,
        upstreamModel: r.upstreamModel,
        priceInPerMTok: r.priceInPerMTok,
        priceOutPerMTok: r.priceOutPerMTok,
        chatModel: kind === 'chat' ? bundle.chatModel(r.upstreamModel) : null,
        embeddingModel: kind === 'embedding' ? bundle.embeddingModel(r.upstreamModel) : null,
        hopKey: hopKeyOf(alias, r.provider.name, r.upstreamModel),
      })
    }

    // 刷新 embedding 健康键缓存 供同步的 embeddingHealthy 使用
    if (kind === 'embedding') {
      this.embeddingHopKeys = hops.map(h => h.hopKey)
    }

    return filterByHealth(hops, this.health)
  }

  /** 建立一条流：读首分片暴露上游错误 成功后返回可迭代流与用量 Promise */
  private async establishStream(hop: RouteHop, opts: RouteCallOpts, started: number): Promise<GatewayStream> {
    const result = streamText({
      model: hop.chatModel as LanguageModel,
      messages: opts.messages,
      temperature: opts.temperature,
      maxRetries: 0,
      // AI SDK v7 默认禁止 messages 带 system 角色 调用方可能传 需放开
      allowSystemInMessages: true,
    })

    // 立即读首分片 触发真实网络请求 让 401/网络错在返回前暴露 供降级循环换下一跳
    const iterator = result.textStream[Symbol.asyncIterator]()
    const first = await iterator.next()

    // 必须访问 result.usage：SDK 的 textStream 内部靠 tee 分流
    // 只读 textStream 不读 usage 会让另一分支背压 流卡在首分片之后
    // 访问 usage 会触发 SDK 排空另一分支 同时以流完成时机作为记账时机
    const usage = Promise.resolve(result.usage)
      .then(async u => {
        const inputTokens = u.inputTokens ?? 0
        const outputTokens = u.outputTokens ?? 0
        const cost = this.computeCost(hop, inputTokens, outputTokens)
        const info = this.buildUsageInfo(hop, inputTokens, outputTokens)

        try {
          await this.recordSuccess(hop, 'LLM', opts.ctx, inputTokens, outputTokens, cost, Date.now() - started)
          this.health.recordSuccess(hop.hopKey)
        } catch (err) {
          this.logger.error(`记账失败 alias=${hop.alias} ${describeError(err)}`)
        }
        // 运行时附带 costCny 供 HTTP 响应展示 契约 UsageInfo 不含它
        return { ...info, costCny: cost.toNumber() }
      })
      .catch(err => {
        // 流中途失败 用量拿不到 返回零值不抛 避免未处理拒绝
        this.logger.warn(`alias=${opts.alias} provider=${hop.providerName} 流错误 ${describeError(err)}`)
        return { ...this.buildUsageInfo(hop, 0, 0), costCny: 0 }
      })

    if (first.done) {
      return { textStream: emptyTextStream(), usage }
    }

    return {
      // 首分片已提前读出 先交还调用方 其余循环 next 续接原迭代器
      // 不用 yield* 是因为 AsyncIterator 类型未声明 Symbol.asyncIterator 手动 next 更稳
      textStream: (async function* () {
        yield first.value
        while (true) {
          const next = await iterator.next()
          if (next.done) return
          yield next.value
        }
      })(),
      usage,
    }
  }

  /** 构造一次调用的用量事实 */
  private buildUsageInfo(hop: RouteHop, inputTokens: number, outputTokens: number): UsageInfo {
    return {
      inputTokens,
      outputTokens,
      providerName: hop.providerName,
      model: hop.upstreamModel,
      routeAlias: hop.alias,
    }
  }

  /**
   * 成本精算 全程 Prisma.Decimal 避免浮点误差
   * 成本 = (入 token * 入价 + 出 token * 出价) / 100 万（价格单位元/百万 token）
   */
  private computeCost(hop: RouteHop, inputTokens: number, outputTokens: number): Prisma.Decimal {
    const inTok = new Prisma.Decimal(inputTokens)
    const outTok = new Prisma.Decimal(outputTokens)
    return inTok.mul(hop.priceInPerMTok).add(outTok.mul(hop.priceOutPerMTok)).div(1_000_000)
  }

  /** 成功记账 统一入口 */
  private async recordSuccess(
    hop: RouteHop,
    kind: 'LLM' | 'EMBEDDING',
    ctx: TenantCtx | undefined,
    inputTokens: number,
    outputTokens: number,
    cost: Prisma.Decimal,
    latencyMs: number,
  ): Promise<void> {
    await this.meter.record({
      kind,
      routeAlias: hop.alias,
      providerName: hop.providerName,
      model: hop.upstreamModel,
      inputTokens,
      outputTokens,
      costCny: cost.toNumber(),
      latencyMs,
      success: true,
      ctx,
    })
  }

  /** 失败记账 统一入口 失败成本记 0 但保留 errorCode 供审计 */
  private async recordFailure(
    hop: RouteHop,
    kind: 'LLM' | 'EMBEDDING',
    ctx: TenantCtx | undefined,
    error: unknown,
    latencyMs: number,
  ): Promise<void> {
    await this.meter.record({
      kind,
      routeAlias: hop.alias,
      providerName: hop.providerName,
      model: hop.upstreamModel,
      inputTokens: 0,
      outputTokens: 0,
      costCny: 0,
      latencyMs,
      success: false,
      errorCode: errorCodeOf(error),
      ctx,
    })
  }
}
