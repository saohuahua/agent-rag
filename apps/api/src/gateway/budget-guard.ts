import { Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { BudgetExceededError } from './errors'

/**
 * 企业月度预算软熔断
 * 为什么在模型调用前查而不是写账前查：熔断要在花钱之前生效
 * 若先调模型再拒绝 超预算后仍会白烧 token
 * 平台级调用（无 enterpriseId）不设预算 直接放行
 */
@Injectable()
export class BudgetGuard {
  constructor(private readonly prisma: PrismaService) {}

  /** 当月起始时间 本地时区 用于聚合当月累计成本 */
  private monthStart(): Date {
    const d = new Date()
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    return d
  }

  /**
   * 校验企业当月累计成本是否超预算 超则抛 BudgetExceededError 语义 429
   * @param enterpriseId 租户 id 缺省表示平台级调用 跳过校验
   */
  async assertWithinBudget(enterpriseId?: number): Promise<void> {
    if (enterpriseId === undefined) return

    const enterprise = await this.prisma.enterprise.findUnique({
      where: { id: enterpriseId },
      select: { monthlyBudgetCny: true },
    })
    if (!enterprise) return

    const agg = await this.prisma.usageRecord.aggregate({
      where: { enterpriseId, createdAt: { gte: this.monthStart() } },
      _sum: { costCny: true },
    })

    const spent = agg._sum.costCny ?? new Prisma.Decimal(0)

    if (spent.gte(enterprise.monthlyBudgetCny)) {
      throw new BudgetExceededError(enterpriseId, enterprise.monthlyBudgetCny.toFixed(2))
    }
  }
}
