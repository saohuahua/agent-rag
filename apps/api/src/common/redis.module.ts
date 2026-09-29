import { Global, Module } from '@nestjs/common'
import Redis from 'ioredis'
import { EnvService } from '../config/env.service'

/** DI token：共享 redis 客户端（锁/健康检查用 各任务注入使用） */
export const REDIS_CLIENT = 'REDIS_CLIENT'

/**
 * 全局 Redis 模块
 * maxRetriesPerRequest 设 null 是 BullMQ 对共享客户端的硬要求（其内部自行管理重试）
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [EnvService],
      useFactory: (env: EnvService) =>
        new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
