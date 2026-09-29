import { Inject, Injectable } from '@nestjs/common'
import { Processor, WorkerHost } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
import { streamText } from 'ai'
import type { ModelMessage } from 'ai'
import type { TenantCtx } from '@agent-rag/shared'
import { PrismaService } from '../prisma/prisma.service'
import { SessionLockService } from './session-lock.service'
import { ContextBuilder } from './context-builder'
import { ToolboxService } from './toolbox'
import { EventsService } from './events.service'
import { SessionService } from './session.service'
import { CHAT_MODEL_RESOLVER } from './agent-model'
import type { ChatModelResolver } from './agent-model'
import { LockBusyError } from './runtime.errors'
import type { EventSink } from '../skills/skill-executor'

/** agent-turn 队列名 与 runtime.module 注册一致 */
export const AGENT_TURN_QUEUE = 'agent-turn'

/** turn job 数据 */
export interface AgentTurnJobData {
  sessionId: number
  message: string
  ctx: TenantCtx
}

/** 一次 turn 的结果 */
export interface TurnOutcome {
  epoch: number
  assistantText: string
}

/** 流式 delta 回调（同步模式直接写 SSE 异步模式经 pub/sub 转发） */
export type DeltaSink = (delta: string) => void | Promise<void>

/**
 * turn 主流程（BullMQ WorkerHost + 同步降级入口）
 * 八步：锁 → epoch → 存 user 消息 → 上下文 → 工具集 → streamText → 存 assistant 消息 → TURN_END 释放锁
 * 串行策略：同一会话并发 turn 靠「锁失败抛错 → BullMQ 重排」等效排队（job group 为 Pro 特性 已降级）
 * 详细锁原理见 session-lock.service.ts 头注释
 */
@Injectable()
@Processor(AGENT_TURN_QUEUE, { concurrency: 4 })
export class TurnProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lock: SessionLockService,
    private readonly contextBuilder: ContextBuilder,
    private readonly toolbox: ToolboxService,
    private readonly events: EventsService,
    private readonly sessions: SessionService,
    @Inject(CHAT_MODEL_RESOLVER) private readonly modelResolver: ChatModelResolver,
  ) {
    super()
  }

  /**
   * BullMQ worker 入口 由队列驱动
   * 失败抛错让 BullMQ 按 attempts/backoff 重排（锁冲突等效排队）
   */
  async process(job: Job<AgentTurnJobData>): Promise<TurnOutcome> {
    const { sessionId, message, ctx } = job.data

    // 异步模式 delta 走 Redis pub/sub 由 controller 的 SSE 订阅转发到前端
    const onDelta: DeltaSink = async delta => {
      await this.events.publishDelta(sessionId, delta)
    }

    try {
      const outcome = await this.runTurn(sessionId, message, ctx, onDelta)
      await this.events.publishStreamEnd(sessionId)
      return outcome
    } catch (e) {
      // 无论成败都发流结束哨兵 让 SSE 订阅端正常关闭
      await this.events.publishStreamEnd(sessionId)
      throw e
    }
  }

  /**
   * 同步降级入口：turn 请求内直接跑完整流程 不开 worker 锁仍生效
   * 供单测与「同步降级模式端到端」使用 流式 delta 直接回调
   */
  async processSync(sessionId: number, message: string, ctx: TenantCtx, onDelta: DeltaSink): Promise<TurnOutcome> {
    return this.runTurn(sessionId, message, ctx, onDelta)
  }

  /** 主流程 八步（锁/epoch/消息/上下文/工具/流/落库/收尾） */
  private async runTurn(
    sessionId: number,
    userMessage: string,
    ctx: TenantCtx,
    onDelta: DeltaSink,
  ): Promise<TurnOutcome> {
    // 1 获取会话锁 失败即排队信号
    const token = await this.lock.tryAcquire(sessionId)
    if (!token) {
      await this.events.emit({ sessionId, type: 'LOCK_WAIT', payload: { message: userMessage } })
      throw new LockBusyError(sessionId)
    }

    const stopWatchdog = this.lock.startWatchdog(sessionId, token)
    let epoch = 0

    try {
      // 2 epoch 自增 拿本次的 fencing token
      epoch = await this.lock.bumpEpoch(sessionId)

      // 解析当前持有者与其模板（员工 → 模板 → 技能/知识库绑定）
      const turn = await this.sessions.resolveTurnContext(sessionId, ctx.enterpriseId)

      const emit = this.eventSink(sessionId, turn.employeeId)
      await emit('TURN_START', { message: userMessage })

      // 3 消息史（不含当前消息 当前消息随后追加）
      const history = await this.sessions.loadHistory(sessionId)

      // 3 持久化 user 消息（带 epoch fencing 迟到写在此被拒）
      await this.lock.guardEpoch(sessionId, epoch, tx =>
        tx.conversationMessage.create({
          data: {
            sessionId,
            role: 'USER',
            employeeId: null,
            epoch,
            partsJson: [{ type: 'text', text: userMessage }],
            text: userMessage,
          },
        }),
      )

      // 4 上下文组装（system 模板 + KB INJECT + 工具清单 + 消息史）
      const built = await this.contextBuilder.build({
        enterpriseId: turn.enterpriseId,
        systemPrompt: turn.systemPrompt,
        kbInject: turn.kbInject,
        query: userMessage,
        history,
        toolDescriptions: this.toolbox.toolDescriptions(turn.skillConfigs),
        onTruncate: dropped => {
          void emit('TRUNCATE', { dropped })
        },
      })

      // 5 工具集（模板绑定技能 + 内置 handover）handover 会采纳新 epoch
      const handover = async (opts: { targetEmployeeKey: string; reason: string }) => {
        const res = await this.sessions.takeover({
          sessionId,
          enterpriseId: turn.enterpriseId,
          targetEmployeeKey: opts.targetEmployeeKey,
          reason: opts.reason,
          epoch,
        })
        // 接管成功 epoch 已自增 当前 turn 采纳新纪元 后续写继续有效
        if (res.ok && res.newEpoch !== undefined) epoch = res.newEpoch
        return res
      }

      const tools = this.toolbox.build({
        sessionId,
        employeeId: turn.employeeId,
        templateSlug: turn.templateSlug,
        skillConfigs: turn.skillConfigs,
        tenantCtx: ctx,
        emit,
        handover,
      })

      // 6 模型调用（工具循环由 AI SDK 自动完成）
      const model = await this.modelResolver.resolve('chat')

      const messages: ModelMessage[] = [
        { role: 'system', content: built.system },
        ...built.messages,
        { role: 'user', content: userMessage },
      ]

      // allowSystemInMessages：AI SDK v7 默认禁止 messages 里带 system 角色 需显式放开
      // 本项目 system prompt 在 messages 里组装（见上下文三段） 与网关一致 集成期最小兼容修复
      const result = streamText({ model, messages, tools, maxRetries: 0, allowSystemInMessages: true })

      let assistantText = ''
      for await (const delta of result.textStream) {
        if (!delta) continue
        assistantText += delta
        await onDelta(delta)
      }

      // 必须访问 usage 排空 SDK 内部 tee 的另一分支 避免背压（网关同款经验）
      void Promise.resolve(result.usage).catch(() => undefined)

      // 7 持久化 assistant 消息（parts 原样 + text 冗余 + employeeId + epoch）
      await this.lock.guardEpoch(sessionId, epoch, tx =>
        tx.conversationMessage.create({
          data: {
            sessionId,
            role: 'ASSISTANT',
            employeeId: turn.employeeId,
            epoch,
            partsJson: [{ type: 'text', text: assistantText }],
            text: assistantText,
          },
        }),
      )

      await this.prisma.conversationSession.update({
        where: { id: sessionId },
        data: { lastMessageAt: new Date() },
      })

      // 8 收尾事件
      await emit('TURN_END', { textLength: assistantText.length })

      return { epoch, assistantText }
    } catch (e) {
      // 失败也留痕 便于时间线排查 随后原样抛出交给 BullMQ 重排
      try {
        await this.events.emit({ sessionId, type: 'TURN_ERROR', payload: { error: e instanceof Error ? e.message : 'unknown' } })
      } catch {
        // 事件落库失败不影响主错误抛出
      }
      throw e
    } finally {
      // 必释放：停 watchdog 再释放锁 顺序不能反（先停再释放避免续期竞态）
      stopWatchdog()
      await this.lock.release(sessionId, token)
    }
  }

  /** 构造事件回传闭包 绑定会话与当前员工 */
  private eventSink(sessionId: number, employeeId: number): EventSink {
    return async (type, payload) => {
      await this.events.emit({ sessionId, employeeId, type, payload })
    }
  }
}
