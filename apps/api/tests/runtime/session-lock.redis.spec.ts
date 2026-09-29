import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Redis from 'ioredis'
import { SessionLockService } from '../../src/runtime/session-lock.service'
import { StaleEpochError } from '../../src/runtime/runtime.errors'
import type { PrismaService } from '../../src/prisma/prisma.service'

/**
 * 真实 Redis 集成测试：验证三段 Lua 与 epoch fencing 的真实并发语义
 * 依赖本地 Redis（pnpm db:up 起 127.0.0.1:6379）不可用时用例静默跳过并告警
 * 其中「锁过期被接管后旧 worker 迟到写被拒」是全项目最有说服力的单测 用真实 Redis + 真实时序
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

let redis: Redis | null = null
let redisB: Redis | null = null

beforeAll(async () => {
  try {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 800, lazyConnect: true })
    await redis.connect()
    await redis.ping()
    redisB = redis.duplicate()
  } catch (e) {
    redis = null
    redisB = null
    console.warn(`[session-lock.redis] 跳过全部用例：Redis 不可用（${e instanceof Error ? e.message : String(e)}）请先 pnpm db:up`)
  }
})

afterAll(async () => {
  await redis?.quit()
  await redisB?.quit()
})

/** 会话 id 自增 防用例间键串扰 */
let seq = 0
const nextId = () => 100_000 + seq++

/** 只实现 epoch 语义的假 Prisma 两个 worker 共享同一状态 与真实 DB 时序一致 */
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
  return {
    prisma: {
      $queryRaw: queryRaw,
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService,
    state,
  }
}

describe('真实 Redis 会话锁', () => {
  it('tryAcquire 互斥：两个 client 同一会话只能一个成功', async () => {
    if (!redis || !redisB) return console.warn('跳过：Redis 不可用')

    const id = nextId()
    const a = new SessionLockService(redis, {} as unknown as PrismaService)
    const b = new SessionLockService(redisB, {} as unknown as PrismaService)

    const tokenA = await a.tryAcquire(id)
    expect(tokenA).toBeTypeOf('string')

    const tokenB = await b.tryAcquire(id)
    expect(tokenB).toBeNull()

    await a.release(id, tokenA as string)
  })

  it('释放后另一 worker 可再获', async () => {
    if (!redis || !redisB) return console.warn('跳过：Redis 不可用')

    const id = nextId()
    const a = new SessionLockService(redis, {} as unknown as PrismaService)
    const b = new SessionLockService(redisB, {} as unknown as PrismaService)

    const tokenA = await a.tryAcquire(id)
    expect(tokenA).toBeTypeOf('string')
    await a.release(id, tokenA as string)

    const tokenB = await b.tryAcquire(id)
    expect(tokenB).toBeTypeOf('string')
    await b.release(id, tokenB as string)
  })

  it('token 校验：A 锁过期后 B 持有 A 迟到释放不误删 B 的锁', async () => {
    if (!redis || !redisB) return console.warn('跳过：Redis 不可用')

    const id = nextId()
    const a = new SessionLockService(redis, {} as unknown as PrismaService, { lockTtlMs: 50 })
    const b = new SessionLockService(redisB, {} as unknown as PrismaService, { lockTtlMs: 30_000 })

    const tokenA = await a.tryAcquire(id)
    expect(tokenA).toBeTypeOf('string')

    // A 的锁 TTL 50ms 过期 期间 A 未释放
    await sleep(80)

    const tokenB = await b.tryAcquire(id)
    expect(tokenB).toBeTypeOf('string')

    // A 迟到释放 用旧 token GET==tokenA 不成立 返回 0 不删 B 的锁
    const released = await a.release(id, tokenA as string)
    expect(released).toBe(false)

    // B 仍持有 续期成功证明锁没被误删
    const renewed = await b.renew(id, tokenB as string)
    expect(renewed).toBe(true)

    await b.release(id, tokenB as string)
  })

  it('watchdog 续期：持有超过 TTL 的任务锁不丢', async () => {
    if (!redis || !redisB) return console.warn('跳过：Redis 不可用')

    const id = nextId()
    const lock = new SessionLockService(redis, {} as unknown as PrismaService, {
      lockTtlMs: 150,
      watchdogIntervalMs: 40,
    })

    const token = await lock.tryAcquire(id)
    expect(token).toBeTypeOf('string')

    const stop = lock.startWatchdog(id, token as string)
    // 等待超过 TTL 若 watchdog 工作锁仍在
    await sleep(400)

    const holder = await redisB.get(`lock:session:${id}`)
    expect(holder).toBe(token)

    stop()
    await lock.release(id, token as string)
  })

  it('真实并发：锁过期被接管后旧 worker 迟到写被拒（fencing 兜底）', async () => {
    if (!redis || !redisB) return console.warn('跳过：Redis 不可用')

    const id = nextId()
    const { prisma } = fakePrisma(1)

    // worker A 短 TTL 且不续期（模拟 GC 停顿期间 watchdog 也停）
    const workerA = new SessionLockService(redis, prisma, { lockTtlMs: 60, watchdogIntervalMs: 60_000 })
    // worker B 正常 TTL
    const workerB = new SessionLockService(redisB, prisma, { lockTtlMs: 60_000, watchdogIntervalMs: 60_000 })

    // A 拿锁 + 自增 epoch（1→2）
    const tokenA = await workerA.tryAcquire(id)
    expect(tokenA).toBeTypeOf('string')
    const epochA = await workerA.bumpEpoch(id)

    // A 停顿 120ms 超过 TTL 60ms 锁被 Redis 自动释放
    await sleep(120)

    // B 接管 拿锁成功 + 自增 epoch（2→3）
    const tokenB = await workerB.tryAcquire(id)
    expect(tokenB).toBeTypeOf('string')
    const epochB = await workerB.bumpEpoch(id)

    // B 写消息 纪元匹配 成功
    const written = await workerB.guardEpoch(id, epochB, async () => 'B-ok')
    expect(written).toBe('B-ok')

    // A 苏醒 迟到写 带旧 epoch=2 当前已 3 被拒
    await expect(workerA.guardEpoch(id, epochA, async () => 'A-late')).rejects.toBeInstanceOf(StaleEpochError)

    await workerB.release(id, tokenB as string)
  })
})
