import { Injectable } from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { EnterpriseContextService } from './enterprise-context.service'
import { AuditService } from './audit.service'
import { tenantStorage } from './enterprise-context.service'
import { TenantConflictError, TenantInvalidStateError, TenantNotFoundError } from './tenant.errors'
import type { MemberRole } from '../generated/prisma/enums'

/** 邀请有效期 48 小时（规格 §4.2） */
const INVITE_TTL_MS = 48 * 60 * 60 * 1000

/**
 * 邀请服务：token 一次性邀请（48h 过期）
 * accept 必须在无上下文作用域执行：受邀者当前属于自己的企业 但 member 要写到邀请的目标企业
 *   所以 run(null, fn) 清空上下文 让扩展直通 全部 enterpriseId 显式写入（避免扩展误注入调用方企业）
 */
@Injectable()
export class InvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: EnterpriseContextService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 创建邀请 返回邀请行与 token
   * @param email 受邀邮箱
   * @param role 受邀角色 默认 MEMBER
   * @param departmentId 受邀后所属部门 可选
   */
  async create(email: string, role: MemberRole, departmentId?: number) {
    const ctxTenant = this.ctx.require()

    // 部门可选 给了必须属于本企业（扩展会过滤 查不到即非本企业）
    if (departmentId !== undefined && departmentId !== null) {
      const dept = await this.prisma.department.findFirst({ where: { id: departmentId } })
      if (!dept) {
        throw new TenantNotFoundError('department not found in current tenant')
      }
    }

    const token = randomBytes(32).toString('hex')
    const inv = await this.prisma.invitation.create({
      data: {
        enterpriseId: ctxTenant.enterpriseId,
        email: email.trim().toLowerCase(),
        role,
        departmentId: departmentId ?? null,
        token,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    })

    await this.audit.write({
      action: 'INVITE_CREATE',
      targetType: 'Invitation',
      targetId: inv.id,
      after: { email: inv.email, role: inv.role },
    })

    return inv
  }

  /** 本企业邀请列表（倒序） */
  async list() {
    return this.prisma.invitation.findMany({ orderBy: { id: 'desc' } })
  }

  /**
   * 接受邀请：校验 token 一次性 建目标企业成员
   * 全程无上下文作用域 显式写 enterpriseId（见类头 why）
   * @param token 邀请 token
   * @param userId 接受者自然人 id（来自 JWT sub）
   * @returns 新建成员摘要
   */
  async accept(token: string, userId: number): Promise<{ memberId: number; enterpriseId: number; role: MemberRole }> {
    // 清空上下文（box 置 null）让扩展直通 全部 enterpriseId 显式写入
    return tenantStorage.run({ ctx: null }, async () => {
      const inv = await this.prisma.invitation.findFirst({ where: { token } })
      if (!inv) {
        throw new TenantNotFoundError('invitation not found')
      }
      if (inv.status !== 'PENDING') {
        throw new TenantInvalidStateError('invitation already used')
      }
      if (inv.expiresAt.getTime() < Date.now()) {
        // 过期标记后仍拒绝
        await this.prisma.invitation.update({ where: { id: inv.id }, data: { status: 'EXPIRED' } })
        throw new TenantInvalidStateError('invitation expired')
      }

      // 同企业已有成员身份则拒绝 防重复加入
      const existing = await this.prisma.member.findFirst({ where: { enterpriseId: inv.enterpriseId, userId } })
      if (existing) {
        throw new TenantConflictError('already a member of this enterprise')
      }

      const member = await this.prisma.member.create({
        data: {
          enterpriseId: inv.enterpriseId,
          userId,
          role: inv.role,
          departmentId: inv.departmentId,
        },
      })

      // token 一次性 立即置 ACCEPTED
      await this.prisma.invitation.update({ where: { id: inv.id }, data: { status: 'ACCEPTED' } })

      return { memberId: member.id, enterpriseId: inv.enterpriseId, role: inv.role }
    })
  }
}
