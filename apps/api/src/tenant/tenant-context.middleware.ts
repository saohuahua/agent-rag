import { Injectable, NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { tenantStorage } from './enterprise-context.service'

/**
 * 租户上下文中间件：给每个请求先进入一个空 box（{ctx:null}）
 * 为什么用中间件而非拦截器：拦截器要 new Observable 需直接依赖 rxjs（未在依赖白名单 pnpm 严格不提升）
 *   中间件只需 express 回调 零新依赖
 * 为什么 box 空着进入：Nest 中间件先于守卫执行 此时还没有租户上下文
 *   member.guard 鉴权成功后 enterpriseContext.attach(ctx) 把 ctx 写进同一 box
 *   handler 的 await 诞生在 run 回调内 扩展读到的正是守卫填好的上下文（见 enterprise-context.service 头注释）
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    tenantStorage.run({ ctx: null }, () => next())
  }
}
