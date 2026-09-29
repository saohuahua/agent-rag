/**
 * HTTP_RPA 通用执行器（20-规格/06 §3 要求单文件通用执行器）
 * 文件超 300 行软红线不拆的原因：超时 重试 退避 进度事件 计量构成一个不可分割的重试状态机
 * 拆开会让重试循环的状态流转碎片化 反而更难读 故保留单文件并在此备案
 */
import { Injectable } from '@nestjs/common'
import { z } from 'zod'
import { UsageMeterService } from '../../gateway/usage-meter.service'
import { RpaError, SkillInputError, SkillTimeoutError } from '../errors'
import type { SkillCtx, SkillResult } from '../skill-executor'

/** RPA 请求超时 10 秒 防外部系统挂起拖死技能调用 */
const RPA_TIMEOUT_MS = 10_000

/** 重试上限 首次 + 重试 2 次 */
const MAX_ATTEMPTS = 3

/** 指数退避延迟 1s 4s */
const BACKOFF_MS = [1_000, 4_000] as const

/** 默认 RPA 端点 base url 可由 env MOCK_RPA_URL 覆盖 */
const DEFAULT_BASE_URL = 'http://localhost:3002'

/** RPA 路由 */
interface RpaRoute {
  method: 'POST' | 'GET'
  path: string
  batchField?: string
  batchSize?: number
}

/**
 * 每个 RPA 技能的默认路由 模板绑定时可用 configJson 覆盖 endpoint method
 * batch_scan 默认按 productIds 每 20 个一批 大批量扫描时分批上报进度
 * operate_ticket 路径含 :ticketId 占位符 执行时用入参插值
 */
const RPA_DEFAULTS: Record<string, RpaRoute> = {
  batch_scan: { method: 'POST', path: '/scan', batchField: 'productIds', batchSize: 20 },
  operate_ticket: { method: 'POST', path: '/tickets/:ticketId/operate' },
}

/** configJson 覆盖契约 */
const CONFIG_SCHEMA = z
  .object({
    endpoint: z.string().min(1).optional(),
    method: z.enum(['POST', 'GET']).optional(),
    batchField: z.string().min(1).optional(),
    batchSize: z.number().int().positive().optional(),
  })
  .nullable()

/**
 * 读取 mock-rpa 地址
 * 为什么直接读 process.env 而非 EnvService：EnvService 不归 H 任务维护 无法加 getter
 * 默认 3002 与 20-规格/06 一致 集成期若 mock-rpa 实际端口不同请改 MOCK_RPA_URL
 */
function rpaBaseUrl(): string {
  return process.env.MOCK_RPA_URL || DEFAULT_BASE_URL
}

/**
 * 路径占位符插值 把 /tickets/:ticketId/operate 里的 :ticketId 换成入参值
 * @param path 含占位符的路径模板
 * @param input 已校验的技能入参
 */
function interpolatePath(path: string, input: Record<string, unknown>): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const v = input[name]
    return v == null ? '' : String(v)
  })
}

/**
 * 解析路由 合并默认值 与 configJson 覆盖
 * 为什么用 configJson 覆盖 endpoint：同一执行器服务不同外部系统 端点差异通过模板绑定注入
 */
function resolveRoute(
  skillKey: string,
  input: Record<string, unknown>,
  configJson: unknown | null,
): RpaRoute {
  const def = RPA_DEFAULTS[skillKey]
  const cfg = CONFIG_SCHEMA.safeParse(configJson)
  const c = cfg.success && cfg.data ? cfg.data : {}

  const endpoint = c.endpoint ?? def?.path
  if (!endpoint) {
    throw new SkillInputError(`no rpa route configured for skill=${skillKey}`)
  }

  // 完整 URL 直接用 相对路径拼 base url
  const url = /^https?:\/\//i.test(endpoint) ? endpoint : rpaBaseUrl() + (endpoint.startsWith('/') ? endpoint : `/${endpoint}`)

  return {
    method: c.method ?? def?.method ?? 'POST',
    path: interpolatePath(url, input),
    batchField: c.batchField ?? def?.batchField,
    batchSize: c.batchSize ?? def?.batchSize ?? 20,
  }
}

/**
 * 按 batchField 切分入参 生成一批请求体
 * 无 batchField 或数组长度未超 batchSize 时返回单元素数组即整体请求
 */
function buildBatches(input: Record<string, unknown>, route: RpaRoute): unknown[] {
  if (!route.batchField) return [input]
  const arr = input[route.batchField]
  if (!Array.isArray(arr) || arr.length <= route.batchSize!) return [input]

  const chunks: unknown[] = []
  for (let i = 0; i < arr.length; i += route.batchSize!) {
    chunks.push({ ...input, [route.batchField]: arr.slice(i, i + route.batchSize!) })
  }
  return chunks
}

/** fetch 因 abort 抛出的错误识别 */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

/** 可重试判定 仅 5xx 网络错 超时可重试 4xx 不重试 */
function isRetryable(e: Error): boolean {
  if (e instanceof SkillTimeoutError) return true
  if (e instanceof RpaError) return e.status === undefined || e.status >= 500
  return false
}

/** 错误码 供计量 errorCode 字段 */
function errorCodeOf(e: Error): string {
  if (e instanceof SkillTimeoutError) return 'SkillTimeout'
  if (e instanceof RpaError) return e.status ? `HTTP_${e.status}` : 'NETWORK'
  return 'RPA_UNKNOWN'
}

/** 延迟 可被单测 fake timer 接管 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * HTTP_RPA 通用执行器
 * 每个 RPA 技能共用：10s 超时 + 重试 2 次指数退避 + SKILL_PROGRESS 进度事件 + 计量
 * 为什么成本记 0：mock-rpa 无真实费用 但调用量与延迟真实记录 未来接付费 RPA 时改这一处
 */
@Injectable()
export class HttpRpaExecutor {
  constructor(private readonly meter: UsageMeterService) {}

  /**
   * 执行 RPA 技能
   * @param skillKey 技能 key
   * @param input 已过 zod 校验的入参
   * @param ctx 技能执行上下文
   * @param riskLevel 技能风险级 riskLevel>=2 视为写操作 成功后必记 SKILL_WRITE 审计事件
   */
  async run(
    skillKey: string,
    input: Record<string, unknown>,
    ctx: SkillCtx,
    riskLevel: 1 | 2 | 3,
  ): Promise<SkillResult> {
    const route = resolveRoute(skillKey, input, ctx.configJson)
    const batches = buildBatches(input, route)
    const total = batches.length
    const results: unknown[] = []

    for (let i = 0; i < total; i++) {
      // 分批进度事件 大批量扫描时前端能看到当前扫到第几批
      await ctx.emit('SKILL_PROGRESS', {
        skill: skillKey,
        phase: 'scanning',
        batch: i + 1,
        total,
      })

      const data = await this.requestWithRetry(skillKey, route, batches[i]!, ctx)
      results.push(data)
    }

    // 写操作审计事件 riskLevel>=2 必记 外部副作用可追溯
    if (riskLevel >= 2) {
      await ctx.emit('SKILL_WRITE', { skill: skillKey, input, results })
    }

    const output = total === 1 ? { report: results[0] } : { batches: results }
    return { output, summary: this.summaryFor(skillKey, input) }
  }

  /** 一句话摘要 给 LLM 的收尾说明 */
  private summaryFor(skillKey: string, input: Record<string, unknown>): string {
    if (skillKey === 'batch_scan') {
      const ids = input.productIds
      const n = Array.isArray(ids) ? ids.length : 0
      return `已扫描 ${n} 个商品`
    }
    if (skillKey === 'operate_ticket') {
      return `工单 ${String(input.ticketId)} 已执行 ${String(input.action)}`
    }
    return `RPA 调用完成 ${skillKey}`
  }

  /**
   * 单次 HTTP 请求 + 重试 + 进度事件 + 计量
   * @returns 响应解析后的 JSON
   */
  private async requestWithRetry(
    skillKey: string,
    route: RpaRoute,
    body: unknown,
    ctx: SkillCtx,
  ): Promise<unknown> {
    const started = Date.now()

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // 每次尝试都发进度事件 前端能看到重试序
      await ctx.emit('SKILL_PROGRESS', { skill: skillKey, phase: 'request', attempt })

      try {
        const { status, data } = await this.fetchOnce(route, body)

        if (status >= 200 && status < 300) {
          const latencyMs = Date.now() - started
          await ctx.emit('SKILL_PROGRESS', { skill: skillKey, phase: 'done', attempt, latencyMs })
          await this.meter.record({
            kind: 'RPA',
            routeAlias: skillKey,
            providerName: 'mock-rpa',
            model: 'http',
            costCny: 0,
            latencyMs,
            success: true,
            ctx: ctx.ctx,
            sessionId: ctx.sessionId,
          })
          return data
        }

        throw new RpaError(`rpa http ${status} skill=${skillKey} url=${route.path}`, status)
      } catch (e) {
        // 统一归一成 Error 便于 isRetryable 与 errorCodeOf 收窄
        const err = e instanceof Error ? e : new RpaError(String(e))
        const retryable = isRetryable(err) && attempt < MAX_ATTEMPTS

        if (!retryable) {
          // 记账失败调用 失败成本也是成本 4xx 不重试直接抛
          const latencyMs = Date.now() - started
          await ctx.emit('SKILL_PROGRESS', {
            skill: skillKey,
            phase: 'error',
            attempt,
            error: errorCodeOf(err),
          })
          await this.meter.record({
            kind: 'RPA',
            routeAlias: skillKey,
            providerName: 'mock-rpa',
            model: 'http',
            costCny: 0,
            latencyMs,
            success: false,
            errorCode: errorCodeOf(err),
            ctx: ctx.ctx,
            sessionId: ctx.sessionId,
          })
          throw err
        }

        // 指数退避 1s 4s 再重试
        const delayMs = BACKOFF_MS[attempt - 1] ?? 1000
        await ctx.emit('SKILL_PROGRESS', {
          skill: skillKey,
          phase: 'retry',
          attempt,
          delayMs,
          error: errorCodeOf(err),
        })
        await sleep(delayMs)
      }
    }

    // 理论不可达 保险兜底
    throw new RpaError(`rpa failed skill=${skillKey}`)
  }

  /**
   * 单次 fetch 带 10s 超时
   * 网络错与超时归类为可重试错误 由上层决定是否重试
   */
  private async fetchOnce(
    route: RpaRoute,
    body: unknown,
  ): Promise<{ status: number; data: unknown }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), RPA_TIMEOUT_MS)

    try {
      const init: RequestInit = {
        method: route.method,
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
      }
      if (route.method === 'POST') {
        init.body = JSON.stringify(body)
      }

      const res = await fetch(route.path, init)
      const text = await res.text()

      // 响应按 JSON 解析 失败退回纯文本 不因非 JSON 响应崩溃
      let data: unknown = text
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          // 非 JSON 响应按纯文本返回
        }
      }
      return { status: res.status, data }
    } catch (e) {
      if (isAbortError(e)) {
        throw new SkillTimeoutError(`rpa timeout ${RPA_TIMEOUT_MS}ms url=${route.path}`)
      }
      throw new RpaError(`rpa network error url=${route.path}: ${String(e)}`)
    } finally {
      clearTimeout(timer)
    }
  }
}
