import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { AuthService } from './auth.service'
import { MemberGuard, AUTH_COOKIE } from '../member.guard'
import { TenantUnauthorizedError } from '../tenant.errors'

/** 注册入参 zod 校验：口令最短 8 企业名非空 */
const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(72),
  displayName: z.string().trim().max(50).optional(),
  enterpriseName: z.string().trim().min(1).max(100),
})

/** 登录入参 zod 校验 */
const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

/** 24 小时 cookie 生命周期（毫秒） */
const COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * 认证控制器：注册/登录/登出/当前用户
 * 登录/注册无租户上下文 不挂 member.guard；me 挂 guard 进入 ALS
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** 注册企业 返回 token 并写 HttpOnly cookie */
  @Post('register')
  async register(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = RegisterSchema.parse(body)
    const result = await this.auth.register(input)
    this.setCookie(res, result.token)
    return { user: result.user, member: result.member, enterprise: result.enterprise }
  }

  /** 登录 返回 token 并写 HttpOnly cookie */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = LoginSchema.parse(body)
    const result = await this.auth.login(input)
    this.setCookie(res, result.token)
    return { user: result.user, member: result.member, enterprise: result.enterprise }
  }

  /** 登出 清 cookie */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(AUTH_COOKIE, { path: '/' })
    return { ok: true }
  }

  /** 当前用户（需登录） guard 已把 userId 与上下文挂到 req */
  @Get('me')
  @UseGuards(MemberGuard)
  async me(@Req() req: Request) {
    const userId = req.userId
    const ctx = req.tenantCtx
    if (userId === undefined || !ctx) {
      throw new TenantUnauthorizedError('not authenticated')
    }
    return this.auth.me(userId, ctx.memberId)
  }

  /** 写 HttpOnly 同站 cookie 生产环境应加 secure 本地 HTTP 不加 */
  private setCookie(res: Response, token: string): void {
    res.cookie(AUTH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE_MS,
      path: '/',
    })
  }
}
