import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'

import { EnvModule } from './config/env.module'
import { EnvService } from './config/env.service'
import { PrismaModule } from './prisma/prisma.module'
import { RedisModule } from './common/redis.module'
import { HealthController } from './common/health.controller'
import { GatewayModule } from './gateway/gateway.module'
import { RagModule } from './rag/rag.module'
import { SkillsModule } from './skills/skills.module'
import { RuntimeModule } from './runtime/runtime.module'
import { TenantModule } from './tenant/tenant.module'

/**
 * 根模块：注册全部子模块（本文件与列出的共享件只在任务 0 修改——并行纪律见 prompts/README）
 * .env 的加载在 env.service.ts 模块顶层完成（向上两级根 .env）
 * BullModule.forRootAsync 统一 Redis 连接 各任务的队列只 registerQueue 不再建连接
 */
@Module({
  imports: [
    EnvModule,
    BullModule.forRootAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => ({ connection: { url: env.REDIS_URL } }),
    }),
    PrismaModule,
    RedisModule,
    GatewayModule,
    RagModule,
    SkillsModule,
    RuntimeModule,
    TenantModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
