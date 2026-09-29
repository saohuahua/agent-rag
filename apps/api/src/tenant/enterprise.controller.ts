import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { PrismaService } from '../prisma/prisma.service'
import { EnterpriseContextService } from './enterprise-context.service'
import { InvitationService } from './invitation.service'
import { MemberGuard } from './member.guard'
import { RoleGuard } from './role.guard'
import { Roles } from './roles.decorator'
import { TenantForbiddenError, TenantNotFoundError } from './tenant.errors'
import type { MemberRole } from '../generated/prisma/enums'

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  monthlyBudgetCny: z.number().positive().max(1_000_000).optional(),
})

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).default('MEMBER'),
  departmentId: z.number().int().positive().nullish(),
})

/**
 * 企业信息与邀请控制器
 * 企业只能看/改自己（路由 :id 必须等于当前上下文企业 否则 403）
 */
@Controller('enterprises')
@UseGuards(MemberGuard)
export class EnterpriseController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: EnterpriseContextService,
    private readonly invitations: InvitationService,
  ) {}

  /** 企业信息 */
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    this.assertOwn(id)
    const enterprise = await this.prisma.enterprise.findFirst({ where: { id } })
    if (!enterprise) {
      throw new TenantNotFoundError('enterprise not found')
    }
    return enterprise
  }

  /** 改企业信息/预算（限 OWNER） */
  @Patch(':id')
  @UseGuards(RoleGuard)
  @Roles('OWNER')
  async patch(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    this.assertOwn(id)
    const input = PatchSchema.parse(body)
    return this.prisma.enterprise.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.monthlyBudgetCny !== undefined ? { monthlyBudgetCny: input.monthlyBudgetCny } : {}),
      },
    })
  }

  /** 邀请列表 */
  @Get(':id/invitations')
  async listInvitations(@Param('id', ParseIntPipe) id: number) {
    this.assertOwn(id)
    return this.invitations.list()
  }

  /** 创建邀请（OWNER/ADMIN） */
  @Post(':id/invitations')
  @UseGuards(RoleGuard)
  @Roles('ADMIN')
  createInvitation(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    this.assertOwn(id)
    const input = InviteSchema.parse(body)
    // zod enum 值与 Prisma MemberRole 一致 安全转
    return this.invitations.create(input.email, input.role as MemberRole, input.departmentId ?? undefined)
  }

  /** 路由 :id 必须是当前上下文企业 否则 403 */
  private assertOwn(enterpriseId: number): void {
    const ctx = this.ctx.require()
    if (ctx.enterpriseId !== enterpriseId) {
      throw new TenantForbiddenError('enterprise id does not match current tenant')
    }
  }
}
