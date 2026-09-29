import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { AuditService } from './audit.service'
import { MemberGuard } from './member.guard'
import { RoleGuard } from './role.guard'
import { Roles } from './roles.decorator'

/**
 * 审计日志控制器：企业内 ADMIN 查看
 * AuditLog 是横切表（enterpriseId 可空）list 内部按当前企业显式过滤
 */
@Controller('audit')
@UseGuards(MemberGuard, RoleGuard)
@Roles('ADMIN')
export class AuditController {
  constructor(private readonly service: AuditService) {}

  /** 审计列表 可 ?action=&targetType= 过滤 */
  @Get()
  list(@Query('action') action?: string, @Query('targetType') targetType?: string) {
    return this.service.list({ action, targetType })
  }
}
