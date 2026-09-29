import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { EnterpriseContextService } from './enterprise-context.service'
import { AuditService } from './audit.service'
import { TenantInvalidStateError, TenantNotFoundError } from './tenant.errors'
import type { GrantScopeType } from '../generated/prisma/enums'

/**
 * 员工授权服务：三层 scope 解析 + 授权增删查
 * 解析规则（规格 §4.6）：存在 ACTIVE grant 且
 *   ENTERPRISE（同企业）∨ DEPARTMENT（成员部门路径在授权部门子树内）∨ MEMBER（scopeId=成员）
 * ∧ 订阅 ACTIVE ∧ 员工 ACTIVE
 * 为什么部门用路径前缀判断：物化路径天然支持子树 一个 startsWith 即命中整棵子树（含孙部门）
 */
@Injectable()
export class GrantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: EnterpriseContextService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 授权解析：成员能否使用某数字员工
   * @param memberId 成员 id
   * @param employeeId 员工 id
   * @returns 是否可用
   */
  async canUse(memberId: number, employeeId: number): Promise<boolean> {
    const member = await this.prisma.member.findFirst({ where: { id: memberId }, include: { department: true } })
    const employee = await this.prisma.siliconEmployee.findFirst({ where: { id: employeeId }, include: { subscription: true } })
    if (!member || !employee) return false

    // 员工与订阅都必须 ACTIVE 否则不可用
    if (employee.status !== 'ACTIVE' || employee.subscription.status !== 'ACTIVE') return false

    const grants = await this.prisma.employeeGrant.findMany({ where: { employeeId, status: 'ACTIVE' } })
    for (const g of grants) {
      // 授权必须与本成员同企业
      if (g.enterpriseId !== member.enterpriseId) continue

      if (g.scopeType === 'ENTERPRISE') return true

      if (g.scopeType === 'MEMBER') {
        if (g.scopeId === member.id) return true
        continue
      }

      if (g.scopeType === 'DEPARTMENT') {
        if (!member.department || g.scopeId === null) continue
        const dept = await this.prisma.department.findFirst({ where: { id: g.scopeId } })
        // 成员所在部门路径在授权部门路径下（含自身与孙部门）
        if (dept && member.department.path.startsWith(dept.path)) return true
      }
    }
    return false
  }

  /**
   * 创建授权 校验员工与 scope 目标都属于本企业
   * @param employeeId 员工 id
   * @param scopeType 授权层级
   * @param scopeId DEPARTMENT 部门 id / MEMBER 成员 id / ENTERPRISE null
   */
  async create(employeeId: number, scopeType: GrantScopeType, scopeId?: number | null) {
    const ctxTenant = this.ctx.require()

    // 员工属于本企业（扩展过滤 查不到即 404 防跨企业）
    const emp = await this.prisma.siliconEmployee.findFirst({ where: { id: employeeId } })
    if (!emp) {
      throw new TenantNotFoundError('employee not found in current tenant')
    }

    // scope 归属校验 防止把授权指向别企业的部门/成员
    if (scopeType === 'ENTERPRISE') {
      if (scopeId !== undefined && scopeId !== null) {
        throw new TenantInvalidStateError('ENTERPRISE scope must have null scopeId')
      }
    } else if (scopeType === 'MEMBER') {
      if (scopeId === undefined || scopeId === null) {
        throw new TenantInvalidStateError('MEMBER scope requires scopeId')
      }
      const target = await this.prisma.member.findFirst({ where: { id: scopeId } })
      if (!target) throw new TenantNotFoundError('member scope target not found in current tenant')
    } else if (scopeType === 'DEPARTMENT') {
      if (scopeId === undefined || scopeId === null) {
        throw new TenantInvalidStateError('DEPARTMENT scope requires scopeId')
      }
      const target = await this.prisma.department.findFirst({ where: { id: scopeId } })
      if (!target) throw new TenantNotFoundError('department scope target not found in current tenant')
    }

    const grant = await this.prisma.employeeGrant.create({
      data: {
        enterpriseId: ctxTenant.enterpriseId,
        employeeId,
        scopeType,
        scopeId: scopeId ?? null,
        status: 'ACTIVE',
        grantedBy: ctxTenant.memberId,
      },
    })

    await this.audit.write({
      action: 'GRANT_CREATE',
      targetType: 'EmployeeGrant',
      targetId: grant.id,
      after: { employeeId, scopeType, scopeId: scopeId ?? null },
    })

    return grant
  }

  /** 撤销授权（置 REVOKED 保留记录） */
  async revoke(grantId: number) {
    const grant = await this.prisma.employeeGrant.findFirst({ where: { id: grantId } })
    if (!grant) {
      throw new TenantNotFoundError('grant not found')
    }
    const updated = await this.prisma.employeeGrant.update({ where: { id: grantId }, data: { status: 'REVOKED' } })
    await this.audit.write({
      action: 'GRANT_REVOKE',
      targetType: 'EmployeeGrant',
      targetId: grantId,
      before: { scopeType: grant.scopeType, scopeId: grant.scopeId },
      after: { status: 'REVOKED' },
    })
    return updated
  }

  /** 授权列表 可按 employeeId 过滤 */
  async list(employeeId?: number) {
    return this.prisma.employeeGrant.findMany({
      where: employeeId ? { employeeId } : {},
      include: { employee: true },
      orderBy: { id: 'desc' },
    })
  }
}
