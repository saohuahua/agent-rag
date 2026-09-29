import { Controller, Get, HttpStatus, Inject, ServiceUnavailableException } from '@nestjs/common'
import Redis from 'ioredis'
import { PrismaService } from '../prisma/prisma.service'
import { REDIS_CLIENT } from './redis.module'

/**
 * 健康检查 db 与 redis 双探活
 * @returns 200 {db:'ok',redis:'ok'} 任一失败抛 503 并带失败原因
 */
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get('healthz')
  async healthz() {
    const failures: string[] = []

    // 数据库探活：一条最小查询
    try {
      await this.prisma.$queryRaw`SELECT 1`
    } catch (e) {
      failures.push(`db: ${(e as Error).message}`)
    }

    // redis 探活：PING
    try {
      const pong = await this.redis.ping()
      if (pong !== 'PONG') failures.push(`redis: unexpected reply ${pong}`)
    } catch (e) {
      failures.push(`redis: ${(e as Error).message}`)
    }

    if (failures.length > 0) {
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'infra not ready',
        failures,
      })
    }
    return { db: 'ok', redis: 'ok' }
  }
}
