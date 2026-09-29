import { describe, expect, it, vi } from 'vitest'
import { Prisma } from '../../src/generated/prisma/client'
import { UsageMeterService } from '../../src/gateway/usage-meter.service'
import type { PrismaService } from '../../src/prisma/prisma.service'

/**
 * 账本实现：costCny 必须用 Decimal 实例写入 禁 JS number 直写
 * 这是账本精度的硬约束
 */
describe('UsageMeterService 记账', () => {
  it('costCny 以 Decimal 实例写入 非 number', async () => {
    const create = vi.fn().mockResolvedValue({})
    const prisma = { usageRecord: { create } } as unknown as PrismaService
    const meter = new UsageMeterService(prisma)

    await meter.record({
      kind: 'LLM',
      routeAlias: 'chat',
      providerName: 'deepseek',
      model: 'deepseek-flash',
      inputTokens: 100,
      outputTokens: 200,
      costCny: 0.0012,
      latencyMs: 30,
      success: true,
    })

    expect(create).toHaveBeenCalledTimes(1)
    const data = create.mock.calls[0]?.[0]?.data
    expect(data.costCny).toBeInstanceOf(Prisma.Decimal)
    expect(data.costCny.toString()).toBe('0.0012')
    expect(data.inputTokens).toBe(100)
    expect(data.outputTokens).toBe(200)
    expect(data.success).toBe(true)
  })

  it('失败调用也记账 success=false 带 errorCode', async () => {
    const create = vi.fn().mockResolvedValue({})
    const prisma = { usageRecord: { create } } as unknown as PrismaService
    const meter = new UsageMeterService(prisma)

    await meter.record({
      kind: 'EMBEDDING',
      routeAlias: 'embedding',
      providerName: 'siliconflow',
      model: 'bge-m3',
      costCny: 0,
      latencyMs: 10,
      success: false,
      errorCode: 'HTTP_500',
    })

    const data = create.mock.calls[0]?.[0]?.data
    expect(data.success).toBe(false)
    expect(data.errorCode).toBe('HTTP_500')
  })

  it('无 ctx 时 enterpriseId 落 null 平台级调用', async () => {
    const create = vi.fn().mockResolvedValue({})
    const prisma = { usageRecord: { create } } as unknown as PrismaService
    const meter = new UsageMeterService(prisma)

    await meter.record({
      kind: 'LLM',
      routeAlias: 'chat',
      providerName: 'deepseek',
      model: 'deepseek-flash',
      costCny: 0,
      latencyMs: 5,
      success: true,
    })

    const data = create.mock.calls[0]?.[0]?.data
    expect(data.enterpriseId).toBeNull()
  })
})
