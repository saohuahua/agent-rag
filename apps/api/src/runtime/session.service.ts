import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import type { ConversationSession } from '../generated/prisma/client'
import { SessionLockService } from './session-lock.service'
import { EventsService } from './events.service'
import { InvalidRosterError, LockBusyError, SessionAccessDeniedError, SessionNotFoundError } from './runtime.errors'
import type { HandoverResult } from './toolbox'
import type { HistoryMessage } from './context-builder'

/** 创建会话入参 */
export interface CreateSessionInput {
  enterpriseId: number
  title?: string
  /** 阵容员工 id 数组 slot 按下标顺序 决定接管顺序 */
  participantEmployeeIds: number[]
}

/** 接管入参（handover 工具与 admin takeover 共用） */
export interface TakeoverInput {
  sessionId: number
  enterpriseId: number
  /** 目标员工 displayName 或 id 字符串 */
  targetEmployeeKey: string
  reason: string
  /** 当前 turn 持有的 epoch 凭证 用于校验未被他人接管 */
  epoch: number
}

/** 一次 turn 的运行时上下文（当前持有者 + 其模板 + 绑定技能/知识库） */
export interface TurnContext {
  sessionId: number
  enterpriseId: number
  employeeId: number
  templateSlug: string
  systemPrompt: string
  /** 模板是否带 INJECT/BOTH 知识库绑定 */
  kbInject: boolean
  /** skillKey → 绑定参数注入 */
  skillConfigs: Map<string, unknown | null>
}

/**
 * 会话服务：建会话（阵容校验+授权）消息加载 接管（handover）
 * 授权当前是降级版：只校验员工属于当前企业
 * 完整「企业→部门子树→成员」Grant 三层解析由 D 任务提供 集成由 J 做
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lock: SessionLockService,
    private readonly events: EventsService,
  ) {}

  /**
   * 建会话：阵容去重+非空校验+员工归属校验 首个员工为当前持有者
   */
  async create(input: CreateSessionInput): Promise<ConversationSession> {
    const ids = [...new Set(input.participantEmployeeIds)]
    if (ids.length === 0) throw new InvalidRosterError('roster must contain at least one employee')

    // 授权降级版：员工必须属于当前企业（Grant 树解析待 D 任务）
    const employees = await this.prisma.siliconEmployee.findMany({
      where: { id: { in: ids }, enterpriseId: input.enterpriseId },
      select: { id: true },
    })
    if (employees.length !== ids.length) {
      throw new InvalidRosterError('roster contains employees outside current enterprise')
    }

    // 上面已断言 ids 非空 首个员工即 slot 0 安全
    const firstId = ids[0] as number

    return this.prisma.conversationSession.create({
      data: {
        enterpriseId: input.enterpriseId,
        title: input.title,
        currentParticipantId: firstId,
        participants: { create: ids.map((employeeId, slot) => ({ employeeId, slot })) },
      },
      include: { participants: { include: { employee: true }, orderBy: { slot: 'asc' } } },
    })
  }

  /** 会话列表（本企业）按最近活跃倒序 */
  async list(enterpriseId: number): Promise<ConversationSession[]> {
    return this.prisma.conversationSession.findMany({
      where: { enterpriseId },
      orderBy: { lastMessageAt: 'desc' },
      include: { participants: { include: { employee: true }, orderBy: { slot: 'asc' } } },
    })
  }

  /**
   * 会话详情：会话+参与者+消息全量
   * 企业隔离校验：跨企业访问抛 403
   */
  async getDetail(sessionId: number, enterpriseId: number): Promise<ConversationSession> {
    const session = await this.prisma.conversationSession.findUnique({
      where: { id: sessionId },
      include: {
        participants: { include: { employee: true }, orderBy: { slot: 'asc' } },
        messages: { orderBy: { id: 'asc' } },
      },
    })

    if (!session) throw new SessionNotFoundError(sessionId)
    if (session.enterpriseId !== enterpriseId) throw new SessionAccessDeniedError(sessionId)
    return session
  }

  /**
   * 加载会话消息史（user/assistant 全量 旧→新）供上下文组装
   * 截断（上限 40）由 context-builder 统一处理并记事件
   */
  async loadHistory(sessionId: number): Promise<HistoryMessage[]> {
    const messages = await this.prisma.conversationMessage.findMany({
      where: { sessionId, role: { in: ['USER', 'ASSISTANT'] } },
      orderBy: { id: 'asc' },
      select: { role: true, text: true },
    })

    return messages.map(m => ({
      role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
      content: m.text,
    }))
  }

  /**
   * 解析一次 turn 的运行时上下文：当前持有者员工 → 其模板 → 绑定技能/知识库
   * 会话必须属于当前企业 否则抛隔离异常
   */
  async resolveTurnContext(sessionId: number, enterpriseId: number): Promise<TurnContext> {
    const session = await this.prisma.conversationSession.findUnique({
      where: { id: sessionId },
      select: { id: true, enterpriseId: true, currentParticipantId: true },
    })

    if (!session) throw new SessionNotFoundError(sessionId)
    if (session.enterpriseId !== enterpriseId) throw new SessionAccessDeniedError(sessionId)
    if (session.currentParticipantId == null) throw new InvalidRosterError('session has no current participant')

    const employee = await this.prisma.siliconEmployee.findUnique({
      where: { id: session.currentParticipantId },
      select: { id: true, templateSlug: true, templateVersion: true },
    })
    if (!employee) throw new InvalidRosterError('current participant employee missing')

    const template = await this.prisma.employeeTemplate.findUnique({
      where: { slug_version: { slug: employee.templateSlug, version: employee.templateVersion } },
      include: { skillBindings: { orderBy: { order: 'asc' } }, kbBindings: true },
    })
    if (!template) throw new InvalidRosterError('employee template missing')

    const kbInject = template.kbBindings.some(b => b.kbMode === 'INJECT' || b.kbMode === 'BOTH')
    const skillConfigs = new Map(template.skillBindings.map(b => [b.skillKey, b.configJson ?? null]))

    return {
      sessionId: session.id,
      enterpriseId: session.enterpriseId,
      employeeId: employee.id,
      templateSlug: employee.templateSlug,
      systemPrompt: template.systemPrompt,
      kbInject,
      skillConfigs,
    }
  }

  /**
   * 管理端接管：锁保护下 epoch++ + 切换 current_participant + TAKEOVER 事件
   * 与 handover（工具内）区别：无当前 turn epoch 校验 直接锁后接管
   * 目标不在阵容抛 HandoverTargetError
   */
  async adminTakeover(input: {
    sessionId: number
    enterpriseId: number
    employeeId: number
    reason?: string
  }): Promise<HandoverResult> {
    const session = await this.prisma.conversationSession.findUnique({
      where: { id: input.sessionId },
      include: { participants: true },
    })

    if (!session) throw new SessionNotFoundError(input.sessionId)
    if (session.enterpriseId !== input.enterpriseId) throw new SessionAccessDeniedError(input.sessionId)

    const target = session.participants.find(p => p.employeeId === input.employeeId)
    if (!target) {
      return { ok: false, newHolderId: null, error: `employee ${input.employeeId} not in session roster` }
    }

    const token = await this.lock.tryAcquire(input.sessionId)
    if (!token) throw new LockBusyError(input.sessionId)

    try {
      const newEpoch = await this.lock.bumpEpoch(input.sessionId)
      await this.prisma.conversationSession.update({
        where: { id: input.sessionId },
        data: { currentParticipantId: input.employeeId },
      })

      await this.events.emit({
        sessionId: input.sessionId,
        employeeId: input.employeeId,
        type: 'TAKEOVER',
        payload: { reason: input.reason ?? 'admin', fromEmployeeId: session.currentParticipantId, toEmployeeId: input.employeeId },
      })

      return { ok: true, newHolderId: input.employeeId, newEpoch }
    } finally {
      await this.lock.release(input.sessionId, token)
    }
  }

  /**
   * 接管：校验目标在阵容 → 锁保护下 epoch++ + 切换 current_participant → TAKEOVER 事件
   * 目标不在阵容返回 ok=false 由 LLM 向用户说明 不抛异常
   */
  async takeover(input: TakeoverInput): Promise<HandoverResult> {
    const session = await this.prisma.conversationSession.findUnique({
      where: { id: input.sessionId },
      include: { participants: { include: { employee: true }, orderBy: { slot: 'asc' } } },
    })

    if (!session) throw new SessionNotFoundError(input.sessionId)
    if (session.enterpriseId !== input.enterpriseId) throw new SessionAccessDeniedError(input.sessionId)

    // 目标匹配：displayName 或员工 id 字符串 双向接管不限制 slot（由 LLM 判断）
    const target = session.participants.find(
      p => p.employee.displayName === input.targetEmployeeKey || String(p.employeeId) === input.targetEmployeeKey,
    )
    if (!target) {
      return { ok: false, newHolderId: null, error: `target employee "${input.targetEmployeeKey}" not in session roster` }
    }

    const fromEmployeeId = session.currentParticipantId

    // 锁保护下 epoch++ + 切换 原子完成 返回新 epoch 供当前 turn 采纳
    const newEpoch = await this.lock.handover(input.sessionId, input.epoch, target.employeeId)

    await this.events.emit({
      sessionId: input.sessionId,
      employeeId: target.employeeId,
      type: 'TAKEOVER',
      payload: { reason: input.reason, fromEmployeeId, toEmployeeId: target.employeeId },
    })

    return { ok: true, newHolderId: target.employeeId, newEpoch }
  }
}
