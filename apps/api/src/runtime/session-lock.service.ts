import { Inject, Injectable, Optional } from '@nestjs/common'
import type Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
import { REDIS_CLIENT } from '../common/redis.module'
import { PrismaService } from '../prisma/prisma.service'
import type { Prisma } from '../generated/prisma/client'
import { SessionNotFoundError, StaleEpochError } from './runtime.errors'

/*
 * ============================================================================
 * 会话锁 + epoch 双层并发控制（全项目正确性核心）
 * ============================================================================
 *
 * 时序图（文字版 锁过期被接管后旧 worker 迟到写被拒）：
 *
 *   worker A                    Redis                  DB(sessions.epoch)
 *   ─────────                  ─────                  ──────────────────
 *   1 SET lock NX PX30s ──────▶ 成功(持有 tokenA)
 *   2 UPDATE epoch+1 ───────────────────────────────▶ epoch 1 → 2 返回 2
 *   3 读上下文 生成中(GC 停顿 40s) ………………………………
 *        │ (锁 TTL 30s 已过期 Redis 自动删锁)
 *   worker B
 *   4 SET lock NX PX30s ──────▶ 成功(持有 tokenB 旧锁已过期)
 *   5 UPDATE epoch+1 ───────────────────────────────▶ epoch 2 → 3 返回 3
 *   6 B 写消息(带 epoch=3 校验) ────────────────────▶ SELECT FOR UPDATE=3 ✓ 写入
 *   7 A 苏醒 写消息(带 epoch=2) ────────────────────▶ SELECT FOR UPDATE=3 ✗ ≠2 拒绝
 *
 * 为什么分两层：
 *   Redis 锁只解决「互斥」不解决「过期后旧持有者继续写」——A GC 停顿超 TTL 后
 *   B 已接管 但 A 苏醒时 Redis 层拦不住它（锁已易主 这是 Kleppmann 的经典批评）
 *   DB epoch(fencing token) 兜底：每次拿锁后自增 epoch 作为本次的纪元凭证
 *   写消息事务内 SELECT FOR UPDATE 校验当前 epoch 是否仍等于自己的 不等则拒绝
 *   即「正确性不依赖锁的正确性」
 * watchdog 续期：持有期间每 TTL/3 用 Lua「GET==token 则 PEXPIRE」续命
 *   防止长任务正常执行中被过期（只在还持有锁时才续 不会给别人的锁续命）
 */

/** 续期 Lua：GET==token 才 PEXPIRE 原子防「校验与续期间锁易主导致给别人的锁续命」 */
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`

/** 释放 Lua：GET==token 才 DEL 原子防「A 过期 B 持有后 A 迟到的 DEL 误删 B 的锁」 */
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

/** 锁键前缀 与 key 拼接成 lock:session:{id} */
const LOCK_KEY_PREFIX = 'lock:session:'

/** 默认锁 TTL 30s 持有者崩溃后自动释放防死锁 */
const DEFAULT_LOCK_TTL_MS = 30_000

/** 默认 watchdog 间隔 10s = TTL/3 续期足够及时又不空转 */
const DEFAULT_WATCHDOG_INTERVAL_MS = 10_000

/** 事务客户端类型别名 供 guardEpoch 回调使用 */
type Tx = Prisma.TransactionClient

/** 锁构造参数 单测用短 TTL/短间隔模拟过期接管 */
export interface SessionLockOptions {
  lockTtlMs?: number
  watchdogIntervalMs?: number
}

/**
 * 会话锁服务：Redis 互斥锁 + DB epoch fencing + watchdog 续期
 * 获取=单命令 SET NX PX（无需 Lua）释放/续期=Lua 保证 GET+DEL/PEXPIRE 原子
 * epoch 自增与 FOR UPDATE 校验走 raw SQL（见方法内注释）
 */
@Injectable()
export class SessionLockService {
  private readonly lockTtlMs: number
  private readonly watchdogIntervalMs: number

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    // @Optional：options 仅单测注入短 TTL/短间隔 生产走默认 无 provider 时不报错
    @Optional() options?: SessionLockOptions,
  ) {
    this.lockTtlMs = options?.lockTtlMs ?? DEFAULT_LOCK_TTL_MS
    this.watchdogIntervalMs = options?.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS
  }

  /**
   * 尝试获取会话锁 不阻塞 立刻返回成败
   * 每次生成新 token 释放时校验 防误删别人的锁
   * @param sessionId 会话 id
   * @returns 持有凭证 token 失败返回 null（被别人持有）
   */
  async tryAcquire(sessionId: number): Promise<string | null> {
    const token = randomUUID()
    const key = this.lockKey(sessionId)

    // SET NX PX 原子「不存在才设置 带过期」单命令无需 Lua
    const ok = await this.redis.set(key, token, 'PX', this.lockTtlMs, 'NX')

    return ok === 'OK' ? token : null
  }

  /**
   * watchdog 续期：GET==token 才 PEXPIRE
   * @returns 停止函数 调用后 clearInterval 停止续期（turn 结束 finally 必调）
   */
  async renew(sessionId: number, token: string): Promise<boolean> {
    const res = await this.redis.eval(RENEW_LUA, 1, this.lockKey(sessionId), token, String(this.lockTtlMs))
    return res === 1
  }

  /**
   * 释放锁：GET==token 才 DEL（Lua 原子 防误删）
   * @returns 是否真的释放了锁（false 表示锁已易主 不应继续任何写）
   */
  async release(sessionId: number, token: string): Promise<boolean> {
    const res = await this.redis.eval(RELEASE_LUA, 1, this.lockKey(sessionId), token)
    return res === 1
  }

  /**
   * 启动 watchdog 定时续期
   * 为什么用 setInterval 而不是 setTimeout 链：间隔固定 简单可预测
   * 释放锁时由调用方调用返回的 stop 函数停止
   */
  startWatchdog(sessionId: number, token: string): () => void {
    const timer = setInterval(() => {
      // 续期失败忽略（锁已易主或过期 由 epoch 兜底正确性）
      void this.renew(sessionId, token)
    }, this.watchdogIntervalMs)

    // 返回 stop 不返回 timer 避免调用方直接操作句柄
    return () => clearInterval(timer)
  }

  /**
   * epoch 自增 作为本次 turn 的 fencing token
   * 为什么走 raw SQL：ORM 的 updateMany({ epoch: { increment: 1 } }) 无法原子返回新值
   * RETURNING 一次往返拿到新纪元 才有「我的纪元凭证」可言
   * 参数防注入：$queryRaw 标签模板是参数化查询 ${sessionId} 走绑定变量 非字符串拼接
   * @returns 新的 epoch 值
   */
  async bumpEpoch(sessionId: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ epoch: number }>>`
      UPDATE conversation_sessions SET epoch = epoch + 1 WHERE id = ${sessionId} RETURNING epoch
    `

    const epoch = rows[0]?.epoch
    if (epoch === undefined) throw new SessionNotFoundError(sessionId)
    return epoch
  }

  /**
   * epoch 校验内执行写事务（fencing 核心）
   * 事务内 SELECT epoch FOR UPDATE 拿到当前纪元 不等于自己的则抛 StaleEpochError
   * 等于才执行写回调——旧持有者迟到写在此被数据层拒绝
   * 为什么 FOR UPDATE：并发接管时两个写者同时读 epoch 必须锁行串行化 防止读到脏纪元
   * @param sessionId 会话 id
   * @param epoch 本次 turn 持有的纪元凭证
   * @param write 在事务内执行的写回调 仅当纪元有效时执行
   */
  async guardEpoch<T>(sessionId: number, epoch: number, write: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ epoch: number }>>`
        SELECT epoch FROM conversation_sessions WHERE id = ${sessionId} FOR UPDATE
      `

      const current = rows[0]?.epoch
      if (current === undefined) throw new SessionNotFoundError(sessionId)

      if (current !== epoch) {
        throw new StaleEpochError(sessionId, epoch, current)
      }

      return write(tx)
    })
  }

  /**
   * 接管：epoch 校验下原子切换 current_participant 并 epoch+1
   * 为什么 epoch+1 与切换在一条 UPDATE：两个写必须在同一事务原子完成
   * 否则窗口内旧 holder 可写而 current_participant 已变 状态撕裂
   * 新 epoch 返回给当前 turn 更新本地纪元引用 后续写继续有效（仍持锁故安全）
   * @param sessionId 会话 id
   * @param epoch 当前 turn 持有的纪元凭证（校验未被他人接管）
   * @param targetEmployeeId 接管目标员工 id
   * @returns 自增后的新 epoch
   */
  async handover(sessionId: number, epoch: number, targetEmployeeId: number): Promise<number> {
    return this.guardEpoch(sessionId, epoch, async tx => {
      const rows = await tx.$queryRaw<Array<{ epoch: number }>>`
        UPDATE conversation_sessions
        SET epoch = epoch + 1, current_participant_id = ${targetEmployeeId}
        WHERE id = ${sessionId}
        RETURNING epoch
      `

      const newEpoch = rows[0]?.epoch
      if (newEpoch === undefined) throw new SessionNotFoundError(sessionId)
      return newEpoch
    })
  }

  /** 锁键拼接 */
  private lockKey(sessionId: number): string {
    return `${LOCK_KEY_PREFIX}${sessionId}`
  }
}
