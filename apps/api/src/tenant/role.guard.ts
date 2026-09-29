import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ROLES_KEY } from './roles.decorator'
import { EnterpriseContextService } from './enterprise-context.service'
import { TenantForbiddenError, TenantIsolationError } from './tenant.errors'
import type { MemberRole } from '../generated/prisma/enums'

/** 角色权重 OWNER 最高 MEMBER 最低 用于「@Roles(ADMIN) 允许 OWNER」的层级判断 */
const RANK: Record<MemberRole, number> = { OWNER: 3, ADMIN: 2, MEMBER: 1 }

/**
 * 角色守卫：与 @Roles(...) 装饰器配套
 * 未声明角色时放行 声明后校验当前上下文角色是否满足层级
 * 为什么用层级而非精确匹配：OWNER 天然拥有 ADMIN 与 MEMBER 的权限 避免每个端点写三个角色
 */
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly ctxService: EnterpriseContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<MemberRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!required || required.length === 0) return true

    const ctx = this.ctxService.current()
    if (!ctx) {
      throw new TenantIsolationError('role guard requires tenant context (guard order wrong)')
    }

    const allowed = required.some(r => RANK[ctx.role] >= RANK[r])
    if (!allowed) {
      throw new TenantForbiddenError(`requires role ${required.join('|')} but got ${ctx.role}`)
    }
    return true
  }
}
