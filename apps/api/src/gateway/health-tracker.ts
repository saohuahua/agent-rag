import { Injectable } from '@nestjs/common'

/** 健康记录的键：alias + provider/model（一跳一记录） */
export type HopKey = string

/**
 * 路由健康追踪器：连续失败计数 + 冷却期
 * 设计（面试可讲）：为什么每跳不重试——避免故障放大 降级链本身是「换资源重试」
 * 冷却期意味着该跳暂时不参与路由 但全部跳位冷却时放行全部（避免路由彻底瘫痪）
 */
@Injectable()
export class HealthTracker {
  /** 连续失败计数 */
  private readonly failCount = new Map<HopKey, number>()

  /** 冷却截止时间戳(ms) */
  private readonly cooldownUntil = new Map<HopKey, number>()

  /** 触发冷却所需的连续失败次数 */
  static readonly FAIL_THRESHOLD = 3

  /** 冷却时长(ms) 期间该跳被路由过滤 */
  static readonly COOLDOWN_MS = 60_000

  /**
   * 记录一次失败 连续达到阈值进入冷却
   * @param key 跳位键 alias:provider/model
   */
  recordFailure(key: HopKey): void {
    const n = (this.failCount.get(key) ?? 0) + 1
    this.failCount.set(key, n)

    if (n >= HealthTracker.FAIL_THRESHOLD) {
      this.cooldownUntil.set(key, Date.now() + HealthTracker.COOLDOWN_MS)
      this.failCount.set(key, 0)
    }
  }

  /** 记录一次成功 清空连续失败计数 */
  recordSuccess(key: HopKey): void {
    this.failCount.set(key, 0)
  }

  /** 是否处于冷却期 */
  isCooling(key: HopKey): boolean {
    const until = this.cooldownUntil.get(key)
    if (until === undefined) return false

    if (until <= Date.now()) {
      this.cooldownUntil.delete(key)
      return false
    }
    return true
  }
}
