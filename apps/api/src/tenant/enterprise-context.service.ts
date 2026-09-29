import { Injectable } from '@nestjs/common'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { TenantCtx } from '@agent-rag/shared'
import { TenantIsolationError } from './tenant.errors'

/**
 * 请求级租户上下文的 ALS 载体（契约见 10-骨架/04 §6）
 * 为什么 store 是「box 包装」而非裸 TenantCtx：Nest 生命周期里中间件先于守卫执行
 *   中间件先进入空 box（{ctx:null}）随后 member.guard 鉴权成功把 ctx 写进 box
 *   这样扩展在 handler 的 await 内读到的是守卫填好的上下文（box 是同一对象引用）
 * 为什么模块级导出 ALS：prisma-tenant.extension 是纯函数扩展 无法注入 Nest 服务 只能读这个 ALS
 */
export interface TenantBox {
  ctx: TenantCtx | null
}

export const tenantStorage = new AsyncLocalStorage<TenantBox>()

/**
 * 企业上下文服务（@Global 导出 被 rag/runtime/skills 注入）
 * run/current/require 三个方法签名与任务 0 契约桩一致 不可改
 */
@Injectable()
export class EnterpriseContextService {
  /**
   * 在指定上下文中执行 fn（ALS enter/exit）worker 与脚本用
   * 关键：fn 必须是 async 且内部 await 数据库调用 这样 Prisma 7 延迟执行（thenable）才继承上下文
   * 见 prisma-tenant.extension.ts 头注释的 why 说明
   * @param ctx 租户上下文
   * @param fn 在上下文内执行的异步函数
   * @returns fn 的返回值
   */
  run<T>(ctx: TenantCtx, fn: () => Promise<T>): Promise<T> {
    return tenantStorage.run({ ctx }, fn)
  }

  /** 当前上下文 无则 null 请求处理链路用 */
  current(): TenantCtx | null {
    return tenantStorage.getStore()?.ctx ?? null
  }

  /** 必须有上下文 否则抛 TenantIsolationError（拿到即说明 Guard 没接对） */
  require(): TenantCtx {
    const ctx = this.current()
    if (!ctx) {
      throw new TenantIsolationError()
    }
    return ctx
  }

  /**
   * 把上下文写入当前请求的 box（member.guard 鉴权成功后调用）
   * 前提：tenant-context.middleware 已进入空 box 否则无操作（安全 no-op）
   * @param ctx 鉴权后的租户上下文
   */
  attach(ctx: TenantCtx): void {
    const box = tenantStorage.getStore()
    if (box) {
      box.ctx = ctx
    }
  }
}
