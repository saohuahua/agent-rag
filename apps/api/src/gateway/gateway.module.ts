import { Global, Module } from '@nestjs/common'
import { GatewayService } from './gateway.service'
import { ProviderRegistry } from './provider-registry'
import { ModelRouter } from './model-router'
import { UsageMeterService } from './usage-meter.service'
import { HealthTracker } from './health-tracker'
import { BudgetGuard } from './budget-guard'
import { GatewayController } from './gateway.controller'
import { AdminGatewayController } from './admin-gateway.controller'

/**
 * Token 网关模块
 * 全局导出 GatewayService（契约）与 UsageMeterService（契约实现）
 * 其余为本模块内部协作件 不对外
 */
@Global()
@Module({
  providers: [
    GatewayService,
    ProviderRegistry,
    ModelRouter,
    UsageMeterService,
    HealthTracker,
    BudgetGuard,
  ],
  controllers: [GatewayController, AdminGatewayController],
  exports: [GatewayService, UsageMeterService],
})
export class GatewayModule {}
