import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { GrantService } from './grant.service'
import { MemberGuard } from './member.guard'
import { RoleGuard } from './role.guard'
import { Roles } from './roles.decorator'

const CreateSchema = z.object({
  employeeId: z.number().int().positive(),
  scopeType: z.enum(['ENTERPRISE', 'DEPARTMENT', 'MEMBER']),
  scopeId: z.number().int().positive().nullish(),
})

/**
 * 授权控制器：创建/撤销/列表/解析
 */
@Controller('grants')
@UseGuards(MemberGuard)
export class GrantController {
  constructor(private readonly service: GrantService) {}

  /** 创建授权（OWNER/ADMIN） */
  @Post()
  @UseGuards(RoleGuard)
  @Roles('ADMIN')
  create(@Body() body: unknown) {
    const input = CreateSchema.parse(body)
    return this.service.create(input.employeeId, input.scopeType, input.scopeId ?? null)
  }

  /** 撤销授权 */
  @Post(':id/revoke')
  @UseGuards(RoleGuard)
  @Roles('ADMIN')
  revoke(@Param('id', ParseIntPipe) id: number) {
    return this.service.revoke(id)
  }

  /** 授权解析：成员能否用某员工（运行时接管前调用） */
  @Get('check')
  check(@Query('memberId', ParseIntPipe) memberId: number, @Query('employeeId', ParseIntPipe) employeeId: number) {
    return this.service.canUse(memberId, employeeId)
  }

  /** 授权列表 可 ?employeeId= 过滤 */
  @Get()
  list(@Query('employeeId', new ParseIntPipe({ optional: true })) employeeId?: number) {
    return this.service.list(employeeId)
  }
}
