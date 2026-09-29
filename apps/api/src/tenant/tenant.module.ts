import { Global, MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common'
import { EnterpriseContextService } from './enterprise-context.service'
import { TenantContextMiddleware } from './tenant-context.middleware'
import { MemberGuard } from './member.guard'
import { RoleGuard } from './role.guard'
import { AuthService } from './auth/auth.service'
import { AuthController } from './auth/auth.controller'
import { EnterpriseController } from './enterprise.controller'
import { InvitationService } from './invitation.service'
import { InvitationController } from './invitation.controller'
import { DepartmentService } from './department.service'
import { DepartmentController } from './department.controller'
import { TemplateService } from './template/template.service'
import { TemplateController } from './template/template.controller'
import { PackageService } from './package/package.service'
import { PackageController } from './package/package.controller'
import { SubscriptionService } from './subscription.service'
import { SubscriptionController } from './subscription.controller'
import { GrantService } from './grant.service'
import { GrantController } from './grant.controller'
import { AuditService } from './audit.service'
import { AuditController } from './audit.controller'

/**
 * 企业多租户模块（@Global）
 * 对外契约导出 EnterpriseContextService（10-骨架/04 §6）
 * 附加导出 GrantService（授权解析 运行时接管用）与 AuditService（审计统一写入）均为增量不破坏契约
 * 中间件 TenantContextMiddleware 全路由注册 无 tenantCtx 时直通（网关/健康检查不受影响）
 */
@Global()
@Module({
  controllers: [
    AuthController,
    EnterpriseController,
    InvitationController,
    DepartmentController,
    TemplateController,
    PackageController,
    SubscriptionController,
    GrantController,
    AuditController,
  ],
  providers: [
    EnterpriseContextService,
    MemberGuard,
    RoleGuard,
    AuthService,
    InvitationService,
    DepartmentService,
    TemplateService,
    PackageService,
    SubscriptionService,
    GrantService,
    AuditService,
  ],
  exports: [EnterpriseContextService, GrantService, AuditService],
})
export class TenantModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 全路由挂 ALS 中间件 只对挂载了 tenantCtx 的请求生效
    consumer.apply(TenantContextMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL })
  }
}
