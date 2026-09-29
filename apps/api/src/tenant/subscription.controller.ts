import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { SubscriptionService } from './subscription.service'
import { MemberGuard } from './member.guard'
import { RoleGuard } from './role.guard'
import { Roles } from './roles.decorator'
import { EnterpriseContextService } from './enterprise-context.service'
import { TenantForbiddenError } from './tenant.errors'

const CreateSchema = z.object({ packageId: z.number().int().positive() })

const UpgradeSchema = z.object({ confirm: z.boolean().optional() })

/**
 * 订阅控制器：创建订阅（锁版本）/列表/升级（confirm 才执行）
 * 订阅是企业级资产 创建与升级限 OWNER
 */
@Controller()
@UseGuards(MemberGuard)
export class SubscriptionController {
  constructor(
    private readonly service: SubscriptionService,
    private readonly ctx: EnterpriseContextService,
  ) {}

  /** 创建订阅 锁当前已发布最大版本并 provision 员工 */
  @Post('enterprises/:id/subscriptions')
  @UseGuards(RoleGuard)
  @Roles('OWNER')
  create(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    this.assertOwnEnterprise(id)
    return this.service.create(CreateSchema.parse(body).packageId)
  }

  /** 本企业订阅列表 */
  @Get('enterprises/:id/subscriptions')
  list(@Param('id', ParseIntPipe) id: number) {
    this.assertOwnEnterprise(id)
    return this.service.list()
  }

  /** 升级订阅 confirm=true 才落库 否则返回 diff 预览 */
  @Post('subscriptions/:id/upgrade')
  @UseGuards(RoleGuard)
  @Roles('OWNER')
  upgrade(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    const input = UpgradeSchema.parse(body)
    return this.service.upgrade(id, input.confirm ?? false)
  }

  /** 路由 :id 必须是当前上下文企业 否则 403 防跨企业操作 */
  private assertOwnEnterprise(enterpriseId: number): void {
    const ctx = this.ctx.require()
    if (ctx.enterpriseId !== enterpriseId) {
      throw new TenantForbiddenError('enterprise id does not match current tenant')
    }
  }
}
