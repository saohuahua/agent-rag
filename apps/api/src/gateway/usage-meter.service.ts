import { Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import type { UsageMeter } from '../common/usage-meter'

/** 记账入参类型 直接取自契约接口 保证签名始终一致 */
type RecordEntry = Parameters<UsageMeter['record']>[0]

/**
 * 算力账本实现 所有耗资源调用落 usage_records 一行
 * costCny 用 new Prisma.Decimal 写入 禁 JS number 直写
 * 为什么：列类型是 Decimal(10,6) 若直接传 number Prisma 走浮点转换产生累计误差
 * 显式构造 Decimal 才能保证小数点后 6 位精确
 */
@Injectable()
export class UsageMeterService implements UsageMeter {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 记一行账 失败调用也记 success=false 失败成本也是成本
   * @param entry 计量事实 见契约 usage-meter.ts
   */
  async record(entry: RecordEntry): Promise<void> {
    await this.prisma.usageRecord.create({
      data: {
        enterpriseId: entry.ctx?.enterpriseId ?? null,
        sessionId: entry.sessionId ?? null,
        kind: entry.kind,
        routeAlias: entry.routeAlias,
        providerName: entry.providerName,
        model: entry.model,
        inputTokens: entry.inputTokens ?? 0,
        outputTokens: entry.outputTokens ?? 0,
        costCny: new Prisma.Decimal(entry.costCny),
        latencyMs: entry.latencyMs,
        success: entry.success,
        errorCode: entry.errorCode ?? null,
      },
    })
  }
}
