import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import type { Request } from 'express'
import { PrismaService } from '../prisma/prisma.service'
import { EnvService } from '../config/env.service'
import { EnterpriseContextService } from './enterprise-context.service'
import { verifyJwt } from './auth/jwt'
import { TenantUnauthorizedError } from './tenant.errors'

/** JWT cookie 名 写与读共用（放这里避免 auth.controller ↔ member.guard 循环导入） */
export const AUTH_COOKIE = 'token'

/**
 * 成员守卫：JWT → 活跃 Member → 挂载 TenantCtx（写进请求 box 完成 ALS enter）
 * 为什么 ALS 进入拆成两段：Nest 中间件先于守卫执行 且 canActivate 无法包裹 handler
 *   中间件先进入空 box 本 guard 鉴权成功后 attach(ctx) 把上下文写进同一 box
 *   handler 的 await 诞生在该 box 内 扩展读到守卫填好的 ctx（见 enterprise-context.service 头注释）
 * 为什么守卫里的 member 查询不过滤：attach 之前 box.ctx 仍为 null 直通按 id 查 正确
 */
@Injectable()
export class MemberGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly ctxService: EnterpriseContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>()
    const token = extractToken(req)
    if (!token) {
      throw new TenantUnauthorizedError('missing token')
    }

    const payload = verifyJwt(token, this.env.JWT_SECRET)
    if (!payload) {
      throw new TenantUnauthorizedError('invalid or expired token')
    }

    // 无上下文直通 按 id 查活跃成员
    const member = await this.prisma.member.findFirst({
      where: { id: payload.memberId, status: 'ACTIVE' },
    })
    if (!member) {
      throw new TenantUnauthorizedError('member inactive or missing')
    }

    // 防 JWT 企业 id 与成员实际企业不符（签发后成员被转移的边界情况）
    if (member.enterpriseId !== payload.enterpriseId) {
      throw new TenantUnauthorizedError('tenant mismatch')
    }

    // 挂载上下文：写进请求 box（中间件已进入空 box）供扩展过滤 写 req 供 controller 读取
    const ctx = { enterpriseId: member.enterpriseId, memberId: member.id, role: member.role }
    this.ctxService.attach(ctx)
    req.tenantCtx = ctx
    req.userId = payload.sub
    return true
  }
}

/** 从 cookie 或 Authorization Bearer 头提取 JWT 都没有返回 null */
function extractToken(req: Request): string | null {
  const cookies = parseCookies(req.headers.cookie)
  if (cookies[AUTH_COOKIE]) return cookies[AUTH_COOKIE]

  const auth = req.headers.authorization
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length)
  return null
}

/** 手写 cookie 解析 不引 cookie-parser（避免新依赖） */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    const val = part.slice(eq + 1).trim()
    try {
      out[key] = decodeURIComponent(val)
    } catch {
      out[key] = val
    }
  }
  return out
}
