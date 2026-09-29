import { describe, expect, it } from 'vitest'
import { makeCtxService, ctxOf } from './helpers'
import { tenantStorage } from '../../src/tenant/enterprise-context.service'
import { TenantIsolationError } from '../../src/tenant/tenant.errors'

describe('EnterpriseContextService ALS 上下文', () => {
  it('run 内 current 返回上下文 退出后恢复 null', async () => {
    const svc = makeCtxService()
    const ctx = ctxOf(1, 2)

    const inside = await svc.run(ctx, async () => svc.current())
    expect(inside).toEqual(ctx)
    expect(svc.current()).toBeNull()
  })

  it('require 无上下文抛 TenantIsolationError', () => {
    const svc = makeCtxService()
    expect(() => svc.require()).toThrow(TenantIsolationError)
  })

  it('require 有上下文返回上下文 不抛', async () => {
    const svc = makeCtxService()
    const ctx = ctxOf(3, 4, 'ADMIN')
    await svc.run(ctx, async () => {
      expect(svc.require()).toEqual(ctx)
    })
  })

  it('attach 把上下文写进请求 box（中间件先进入空 box 守卫后填充）', async () => {
    const svc = makeCtxService()
    const ctx = ctxOf(1, 2)

    // 模拟请求链路：中间件进入空 box → 守卫 attach → handler 内 await 后仍在 box
    await tenantStorage.run({ ctx: null }, async () => {
      expect(svc.current()).toBeNull()
      svc.attach(ctx)
      expect(svc.current()).toEqual(ctx)
      await Promise.resolve()
      expect(svc.current()).toEqual(ctx)
    })
    expect(svc.current()).toBeNull()
  })

  it('嵌套 run 内层覆盖 退出内层恢复外层上下文', async () => {
    const svc = makeCtxService()
    const outer = ctxOf(10, 1)
    const inner = ctxOf(20, 2)

    const result = await svc.run(outer, async () => {
      const mid = svc.current()
      const innerSeen = await svc.run(inner, async () => svc.current())
      const afterInner = svc.current()
      return { mid, innerSeen, afterInner }
    })

    expect(result.mid).toEqual(outer)
    expect(result.innerSeen).toEqual(inner)
    expect(result.afterInner).toEqual(outer)
    expect(svc.current()).toBeNull()
  })
})
