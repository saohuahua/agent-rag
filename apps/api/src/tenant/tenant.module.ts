import { Global, Module } from '@nestjs/common'
import { EnterpriseContextService } from './enterprise-context.service'

/**
 * [桩] 企业多租户模块（任务 D 填充：认证/邀请/部门树/模板审核/订阅/授权/审计）
 * 全局导出：rag/runtime/skills 注入 EnterpriseContextService
 */
@Global()
@Module({
  providers: [EnterpriseContextService],
  exports: [EnterpriseContextService],
})
export class TenantModule {}
