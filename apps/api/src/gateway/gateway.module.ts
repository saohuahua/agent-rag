import { Global, Module } from '@nestjs/common'
import { GatewayService } from './gateway.service'

/**
 * [桩] Token 网关模块（任务 A 填充：路由降级/计量/健康/控制器）
 * 全局导出：所有模块注入 GatewayService
 */
@Global()
@Module({
  providers: [GatewayService],
  exports: [GatewayService],
})
export class GatewayModule {}
