import { describe, expect, it } from 'vitest'
import { HealthTracker } from '../../src/gateway/health-tracker'

/**
 * 路由健康追踪器：连续失败计数 + 冷却期
 * 冷却期意味着该跳暂时不参与路由 全部跳位冷却时放行全部
 */
describe('HealthTracker 健康冷却', () => {
  it('连续失败未达阈值前不算冷却', () => {
    const t = new HealthTracker()
    t.recordFailure('a')
    t.recordFailure('a')
    expect(t.isCooling('a')).toBe(false)
  })

  it('连续 3 次失败进入冷却期', () => {
    const t = new HealthTracker()
    t.recordFailure('a')
    t.recordFailure('a')
    t.recordFailure('a')
    expect(t.isCooling('a')).toBe(true)
  })

  it('不同跳位独立计数', () => {
    const t = new HealthTracker()
    t.recordFailure('a')
    t.recordFailure('a')
    t.recordFailure('a')
    expect(t.isCooling('a')).toBe(true)
    expect(t.isCooling('b')).toBe(false)
  })

  it('成功清空连续失败计数', () => {
    const t = new HealthTracker()
    t.recordFailure('a')
    t.recordFailure('a')
    t.recordSuccess('a')
    t.recordFailure('a')
    t.recordFailure('a')
    // 累计失败被成功打断 未达 3 次 不应冷却
    expect(t.isCooling('a')).toBe(false)
  })
})
