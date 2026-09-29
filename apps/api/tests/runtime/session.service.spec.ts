import { describe, expect, it, vi } from 'vitest'
import { SessionService } from '../../src/runtime/session.service'
import { SessionLockService } from '../../src/runtime/session-lock.service'
import { EventsService } from '../../src/runtime/events.service'
import { InvalidRosterError } from '../../src/runtime/runtime.errors'
import type { PrismaService } from '../../src/prisma/prisma.service'

/** 建 SessionService 假依赖 */
function makeService(prisma: unknown) {
  const lock = {
    handover: vi.fn().mockResolvedValue(8),
    tryAcquire: vi.fn().mockResolvedValue('tok'),
    bumpEpoch: vi.fn().mockResolvedValue(8),
    release: vi.fn().mockResolvedValue(true),
  } as unknown as SessionLockService
  const events = { emit: vi.fn().mockResolvedValue({ id: 1 }) } as unknown as EventsService

  return { service: new SessionService(prisma as PrismaService, lock, events), lock, events }
}

describe('会话服务 建会话', () => {
  it('空阵容抛 InvalidRosterError', async () => {
    const prisma = {} as unknown
    const { service } = makeService(prisma)

    await expect(service.create({ enterpriseId: 1, participantEmployeeIds: [] })).rejects.toBeInstanceOf(
      InvalidRosterError,
    )
  })

  it('阵容含其他企业员工抛 InvalidRosterError', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 1 }])
    const prisma = { siliconEmployee: { findMany } }
    const { service } = makeService(prisma)

    await expect(
      service.create({ enterpriseId: 1, participantEmployeeIds: [1, 2] }),
    ).rejects.toBeInstanceOf(InvalidRosterError)
  })

  it('成功建会话 首个员工为当前持有者 slot 按下标', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }])
    const create = vi.fn().mockResolvedValue({ id: 100 })
    const prisma = { siliconEmployee: { findMany }, conversationSession: { create } }
    const { service } = makeService(prisma)

    await service.create({ enterpriseId: 1, title: '售后会话', participantEmployeeIds: [1, 2, 2] })

    expect(create).toHaveBeenCalledTimes(1)
    const data = create.mock.calls[0]?.[0]?.data
    expect(data.currentParticipantId).toBe(1)
    expect(data.participants.create).toEqual([
      { employeeId: 1, slot: 0 },
      { employeeId: 2, slot: 1 },
    ])
  })
})

describe('会话服务 接管', () => {
  it('目标不在阵容返回 ok=false 不抛异常', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 1,
      enterpriseId: 1,
      currentParticipantId: 1,
      participants: [{ employeeId: 1, employee: { displayName: '售后侠' } }],
    })
    const prisma = { conversationSession: { findUnique } }
    const { service } = makeService(prisma)

    const res = await service.takeover({
      sessionId: 1,
      enterpriseId: 1,
      targetEmployeeKey: '不存在的员工',
      reason: '转接',
      epoch: 7,
    })

    expect(res.ok).toBe(false)
    expect(res.error).toContain('not in session roster')
  })

  it('接管成功 锁保护下 epoch++ 切换 发 TAKEOVER 事件', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 1,
      enterpriseId: 1,
      currentParticipantId: 1,
      participants: [
        { employeeId: 1, employee: { displayName: '售后侠' } },
        { employeeId: 2, employee: { displayName: '扫雷' } },
      ],
    })
    const prisma = { conversationSession: { findUnique } }
    const { service, lock, events } = makeService(prisma)

    const res = await service.takeover({
      sessionId: 1,
      enterpriseId: 1,
      targetEmployeeKey: '扫雷',
      reason: '转接给扫描员',
      epoch: 7,
    })

    expect(res.ok).toBe(true)
    expect(res.newHolderId).toBe(2)
    expect(res.newEpoch).toBe(8)
    expect(lock.handover).toHaveBeenCalledWith(1, 7, 2)
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TAKEOVER', employeeId: 2 }),
    )
  })

  it('按员工 id 字符串也能定位目标', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 1,
      enterpriseId: 1,
      currentParticipantId: 1,
      participants: [{ employeeId: 2, employee: { displayName: '扫雷' } }],
    })
    const prisma = { conversationSession: { findUnique } }
    const { service } = makeService(prisma)

    const res = await service.takeover({
      sessionId: 1,
      enterpriseId: 1,
      targetEmployeeKey: '2',
      reason: 'r',
      epoch: 7,
    })

    expect(res.ok).toBe(true)
    expect(res.newHolderId).toBe(2)
  })
})
