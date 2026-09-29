import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpRpaExecutor } from '../../src/skills/executors/http-rpa'
import { RpaError, SkillTimeoutError } from '../../src/skills/errors'
import type { UsageMeterService } from '../../src/gateway/usage-meter.service'
import type { SkillCtx } from '../../src/skills/skill-executor'

/** 构造模拟 HTTP 响应 避免依赖 Node 全局 Response */
function jsonRes(body: unknown, status: number) {
  return {
    status,
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

/** 构造 SkillCtx 返回 emit 供断言 */
function makeCtx() {
  const emit = vi.fn().mockResolvedValue(undefined)
  const ctx: SkillCtx = {
    sessionId: 1,
    employeeId: 2,
    templateSlug: 'service',
    configJson: null,
    ctx: { enterpriseId: 1, memberId: 1, role: 'OWNER' },
    emit,
  }
  return { ctx, emit }
}

/** 构造执行器 返回 meter 供断言 */
function makeExecutor() {
  const meter = { record: vi.fn().mockResolvedValue(undefined) } as unknown as UsageMeterService
  return { executor: new HttpRpaExecutor(meter), meter }
}

/** 连续 await 多次 冲刷嵌套微任务链 配合 fake timer 使用 */
async function flushMicrotasks(times = 50): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('HttpRpaExecutor 重试序列', () => {
  it('500 两次后第三次成功 重试序正确', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonRes({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonRes({ ok: true }, 200))
    vi.stubGlobal('fetch', fetchMock)

    const { executor, meter } = makeExecutor()
    const { ctx, emit } = makeCtx()

    const p = executor.run('batch_scan', { productIds: ['a', 'b'] }, ctx, 1)

    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1000) // 第一次退避 1s
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(4000) // 第二次退避 4s
    await flushMicrotasks()

    const result = await p

    // 三次请求 次序 500 500 200
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // 进度事件 phase 次序 scanning request retry request retry request done
    const phases = emit.mock.calls.map((c) => (c[1] as { phase: string }).phase)
    expect(phases).toEqual(['scanning', 'request', 'retry', 'request', 'retry', 'request', 'done'])

    // retry 事件带 attempt 与退避毫秒
    const retries = emit.mock.calls.filter((c) => (c[1] as { phase: string }).phase === 'retry')
    expect(retries.map((c) => (c[1] as { delayMs: number }).delayMs)).toEqual([1000, 4000])

    // 计量成功 成本 0 调用量真实
    expect(meter.record).toHaveBeenCalledTimes(1)
    const entry = (meter.record as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(entry).toMatchObject({ kind: 'RPA', routeAlias: 'batch_scan', success: true, costCny: 0 })
    expect(entry.latencyMs).toBeTypeOf('number')

    expect(result.summary).toContain('已扫描 2 个商品')
  })
})

describe('HttpRpaExecutor 超时', () => {
  it('超时中断 重试 2 次后抛 SkillTimeoutError', async () => {
    vi.useFakeTimers()
    // fetch 挂起 直到 abort 信号触发才拒绝 模拟超时
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { executor, meter } = makeExecutor()
    const { ctx } = makeCtx()

    const p = executor.run('batch_scan', { productIds: ['a'] }, ctx, 1)
    // 先挂 rejection 断言 再推定时器 避免 runAllTimersAsync 期间拒绝成为未处理拒绝
    const assertion = expect(p).rejects.toBeInstanceOf(SkillTimeoutError)

    await vi.runAllTimersAsync()
    await assertion

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(meter.record).toHaveBeenCalledTimes(1)
    const entry = (meter.record as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(entry).toMatchObject({ success: false, errorCode: 'SkillTimeout' })
  })
})

describe('HttpRpaExecutor 4xx 不重试', () => {
  it('400 立即抛 RpaError 只请求一次', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ error: 'bad request' }, 400))
    vi.stubGlobal('fetch', fetchMock)

    const { executor, meter } = makeExecutor()
    const { ctx } = makeCtx()

    await expect(
      executor.run('operate_ticket', { ticketId: 't1', action: 'refund' }, ctx, 2),
    ).rejects.toBeInstanceOf(RpaError)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const entry = (meter.record as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(entry).toMatchObject({ success: false, errorCode: 'HTTP_400' })
  })
})

describe('HttpRpaExecutor 分批与写操作事件', () => {
  it('45 个商品按 20 每批拆成 3 批 每批一条 scanning 进度', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ ok: true }, 200))
    vi.stubGlobal('fetch', fetchMock)

    const { executor } = makeExecutor()
    const { ctx, emit } = makeCtx()
    const ids = Array.from({ length: 45 }, (_v, i) => `p${i}`)

    await executor.run('batch_scan', { productIds: ids }, ctx, 1)

    expect(fetchMock).toHaveBeenCalledTimes(3)

    // 三批请求体大小 20 20 5
    const sizes = fetchMock.mock.calls.map((c) => {
      const body = JSON.parse((c[1] as { body: string }).body) as { productIds: string[] }
      return body.productIds.length
    })
    expect(sizes).toEqual([20, 20, 5])

    const scanning = emit.mock.calls
      .filter((c) => (c[1] as { phase: string }).phase === 'scanning')
      .map((c) => (c[1] as { batch: number }).batch)
    expect(scanning).toEqual([1, 2, 3])
  })

  it('operate_ticket 写操作 路径插值正确 且记 SKILL_WRITE 审计事件', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ status: 'refunded' }, 200))
    vi.stubGlobal('fetch', fetchMock)

    const { executor } = makeExecutor()
    const { ctx, emit } = makeCtx()

    await executor.run('operate_ticket', { ticketId: 't1', action: 'refund', note: '同意' }, ctx, 2)

    // 路径占位符 :ticketId 被替换
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('/tickets/t1/operate')

    // riskLevel=2 写操作 必记审计事件
    const writes = emit.mock.calls.filter((c) => c[0] === 'SKILL_WRITE')
    expect(writes).toHaveLength(1)
    expect(writes[0]![1]).toMatchObject({ skill: 'operate_ticket' })
  })

  it('riskLevel=1 只读扫描不记 SKILL_WRITE', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ ok: true }, 200))
    vi.stubGlobal('fetch', fetchMock)

    const { executor } = makeExecutor()
    const { ctx, emit } = makeCtx()

    await executor.run('batch_scan', { productIds: ['a'] }, ctx, 1)

    const writes = emit.mock.calls.filter((c) => c[0] === 'SKILL_WRITE')
    expect(writes).toHaveLength(0)
  })
})
