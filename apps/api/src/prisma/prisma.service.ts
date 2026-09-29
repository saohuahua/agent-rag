import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client'
import { EnvService } from '../config/env.service'

/**
 * Prisma 服务（全局）
 * Prisma 7 无查询引擎 走 driver adapter 连接 PGlite socket 层（对 pg 无感知 生产换 Docker Postgres 不改代码）
 * 租户过滤扩展（D 任务产出）将挂载到本类 详见 10-骨架/04 §6
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(env: EnvService) {
    const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })
    super({ adapter })
  }

  async onModuleInit(): Promise<void> {
    await this.$connect()
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}
