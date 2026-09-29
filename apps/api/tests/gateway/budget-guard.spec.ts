import { describe, expect, it, vi } from 'vitest'
import { Prisma } from '../../src/generated/prisma/client'
import { BudgetGuard } from '../../src/gateway/budget-guard'
import { BudgetExceededError } from '../../src/gateway/errors'
import type { PrismaService } from '../../src/prisma/prisma.service'

/**
 * 企业月度预算软熔断 超限抛 429
 * 校验在模型调用前发生 超预算不烧 token
 */
describe('BudgetGuard 预算熔断', () => {
  it('当月累计超预算抛 BudgetExceededError 语义 429', async () => {
    const prisma = {
      enterprise: { findUnique: vi.fn().mockResolvedValue({ monthlyBudgetCny: new Prisma.Decimal(100) }) },
      usageRecord: { aggregate: vi.fn().mockResolvedValue({ _sum: { costCny: new Prisma.Decimal(120) } }) },
    } as unknown as PrismaService
    const guard = new BudgetGuard(prisma)

    const err = await guard.assertWithinBudget(1).catch(e => e)

    expect(err).toBeInstanceOf(BudgetExceededError)
    expect((err as BudgetExceededError).getStatus()).toBe(429)
  })

  it('未超预算放行', async () => {
    const prisma = {
      enterprise: { findUnique: vi.fn().mockResolvedValue({ monthlyBudgetCny: new Prisma.Decimal(100) }) },
      usageRecord: { aggregate: vi.fn().mockResolvedValue({ _sum: { costCny: new Prisma.Decimal(99) } }) },
    } as unknown as PrismaService
    const guard = new BudgetGuard(prisma)

    await expect(guard.assertWithinBudget(1)).resolves.toBeUndefined()
  })

  it('平台级调用（无 enterpriseId）跳过校验', async () => {
    const prisma = {
      enterprise: { findUnique: vi.fn() },
      usageRecord: { aggregate: vi.fn() },
    } as unknown as PrismaService
    const guard = new BudgetGuard(prisma)

    await expect(guard.assertWithinBudget(undefined)).resolves.toBeUndefined()
    expect(prisma.enterprise.findUnique).not.toHaveBeenCalled()
  })
})
