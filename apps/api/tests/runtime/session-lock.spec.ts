import { describe, expect, it, vi } from 'vitest'
import type Redis from 'ioredis'
import { SessionLockService } from '../../src/runtime/session-lock.service'
import { SessionNotFoundError, StaleEpochError } from '../../src/runtime/runtime.errors'
import type { PrismaService } from '../../src/prisma/prisma.service'

/** 造一个只实现 $queryRaw/$transaction 的假 Prisma 供 epoch 逻辑单测 */
function fakePrisma(initialEpoch: number) {
  const state = { epoch: initialEpoch }

  const queryRaw = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const sql = strings.join('?')
    if (sql.includes('SET epoch = epoch + 1')) {
      state.epoch += 1
      return [{ epoch: state.epoch }]
    }
    if (sql.includes('SELECT epoch FROM conversation_sessions')) {
      return [{ epoch: state.epoch }]
    }
    return []
  }

  const tx = { $queryRaw: queryRaw }
  const prisma = {
    $queryRaw: queryRaw,
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  }

  return { prisma: prisma as unknown as PrismaService, state }
}

describe('会话锁 tryAcquire/release/renew', () => {
  it('SET NX 成功返回 token 被他人持有返回 null', async () => {
    const set = vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null)
    const redis = { set } as unknown as Redis
    const lock = new SessionLockService(redis, {} as unknown as PrismaService)

    const tokenA = await lock.tryAcquire(1)
    expect(tokenA).toBeTypeOf('string')

    const tokenB = await lock.tryAcquire(1)
    expect(tokenB).toBeNull()
  })

  it('release 走 Lua 且 key/token 传对 成功返回 true', async () => {
    const evalFn = vi.fn().mockResolvedValue(1)
    const redis = { eval: evalFn } as unknown as Redis
    const lock = new SessionLockService(redis, {} as unknown as PrismaService)

    const ok = await lock.release(7, 'tok-123')
    expect(ok).toBe(true)
    expect(evalFn).toHaveBeenCalledTimes(1)
    expect(evalFn.mock.calls[0]?.[1]).toBe(1)
    expect(evalFn.mock.calls[0]?.[2]).toBe('lock:session:7')
    expect(evalFn.mock.calls[0]?.[3]).toBe('tok-123')
  })

  it('release 锁已易主时返回 false 不会误删', async () => {
    const evalFn = vi.fn().mockResolvedValue(0)
    const redis = { eval: evalFn } as unknown as Redis
    const lock = new SessionLockService(redis, {} as unknown as PrismaService)

    const ok = await lock.release(7, 'stale-token')
    expect(ok).toBe(false)
  })

  it('renew 走续期 Lua 参数带 TTL', async () => {
    const evalFn = vi.fn().mockResolvedValue(1)
    const redis = { eval: evalFn } as unknown as Redis
    const lock = new SessionLockService(redis, {} as unknown as PrismaService, { lockTtlMs: 3000 })

    const ok = await lock.renew(7, 'tok')
    expect(ok).toBe(true)
    expect(evalFn.mock.calls[0]?.[3]).toBe('tok')
    expect(evalFn.mock.calls[0]?.[4]).toBe('3000')
  })
})

describe('watchdog 续期', () => {
  it('按间隔续期 stop 后停止', async () => {
    vi.useFakeTimers()
    const renew = vi.fn().mockResolvedValue(true)
    const redis = { eval: renew } as unknown as Redis
    const lock = new SessionLockService(redis, {} as unknown as PrismaService, { watchdogIntervalMs: 100 })

    const stop = lock.startWatchdog(1, 'tok')
    await vi.advanceTimersByTimeAsync(250)

    expect(renew).toHaveBeenCalledTimes(2)

    stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(renew).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })
})

describe('epoch 自增与 fencing', () => {
  it('bumpEpoch 走 raw SQL 返回自增后的新纪元', async () => {
    const { prisma, state } = fakePrisma(4)
    const lock = new SessionLockService({} as unknown as Redis, prisma)

    const epoch = await lock.bumpEpoch(1)
    expect(epoch).toBe(5)
    expect(state.epoch).toBe(5)
  })

  it('bumpEpoch 会话不存在抛 SessionNotFoundError', async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaService
    const lock = new SessionLockService({} as unknown as Redis, prisma)

    await expect(lock.bumpEpoch(999)).rejects.toBeInstanceOf(SessionNotFoundError)
  })

  it('guardEpoch 纪元匹配时执行写回调', async () => {
    const { prisma } = fakePrisma(3)
    const lock = new SessionLockService({} as unknown as Redis, prisma)

    const write = vi.fn().mockResolvedValue('written')
    const result = await lock.guardEpoch(1, 3, write)
    expect(result).toBe('written')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('guardEpoch 纪元不匹配（旧持有者迟到写）抛 StaleEpochError', async () => {
    const { prisma } = fakePrisma(6)
    const lock = new SessionLockService({} as unknown as Redis, prisma)

    const write = vi.fn()
    await expect(lock.guardEpoch(1, 5, write)).rejects.toBeInstanceOf(StaleEpochError)
    expect(write).not.toHaveBeenCalled()
  })

  it('handover 原子切换 current_participant 并 epoch+1 返回新纪元', async () => {
    const { prisma, state } = fakePrisma(3)
    const lock = new SessionLockService({} as unknown as Redis, prisma)

    const newEpoch = await lock.handover(1, 3, 42)
    expect(newEpoch).toBe(4)
    expect(state.epoch).toBe(4)
  })
})
