import { Inject, Injectable } from '@nestjs/common'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import { REDIS_CLIENT } from '../common/redis.module'
import { PrismaService } from '../prisma/prisma.service'
import type { ExecutionEvent, Prisma } from '../generated/prisma/client'

/** 事件入参 */
export interface EmitEventInput {
  sessionId: number
  messageId?: number
  employeeId?: number
  /** 事件类型 标准值见 20-规格/03（TURN_START/SKILL_START/SKILL_END/TURN_END/LOCK_WAIT/TAKEOVER 等） */
  type: string
  payload?: unknown
}

/** 流通道键 */
const streamChannel = (sessionId: number) => `session:${sessionId}:stream`

/**
 * 执行事件服务：ExecutionEvent 落库 + SSE 推（断线续传）
 * 事件是「可回放的时序真相」落库保证断线续传 内存 EventEmitter 保证实时推
 * 流式 delta 走 Redis pub/sub 绕一跳：生成在 worker 进程 订阅在 controller 进程
 * 为什么 delta 不落库：纯文本增量无回放价值 落库会放大写放大 事件已足够重建时间线
 */
@Injectable()
export class EventsService {
  /** sessionId → 该会话的实时事件发射器 */
  private readonly emitters = new Map<number, EventEmitter>()

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * 落库一条事件并实时推送给订阅者
   * @returns 落库后的事件行（含自增 id 供断线续传游标）
   */
  async emit(input: EmitEventInput): Promise<ExecutionEvent> {
    const rec = await this.prisma.executionEvent.create({
      data: {
        sessionId: input.sessionId,
        messageId: input.messageId ?? null,
        employeeId: input.employeeId ?? null,
        type: input.type,
        // payload 由调用方保证 JSON 可序列化 此处断言安全
        payloadJson: input.payload === undefined ? undefined : (input.payload as Prisma.InputJsonValue),
      },
    })

    this.getEmitter(input.sessionId).emit('event', rec)
    return rec
  }

  /**
   * 订阅会话事件流（SSE 用）支持 afterId 断线续传
   * 为什么先挂监听再回放：回放与监听之间存在窗口 先挂监听把窗口内新事件收进队列
   * 回放时按 id 去重 避免窗口内事件被回放与实时双份推送
   * @param sessionId 会话 id
   * @param afterId 游标 只回放 id 大于它的历史事件 缺省表示只订阅实时
   */
  subscribe(sessionId: number, afterId?: number): AsyncIterable<ExecutionEvent> {
    const emitter = this.getEmitter(sessionId)
    const queue: ExecutionEvent[] = []
    const seen = new Set<number>()
    // 捕获 this 供内部 generator 使用（function* 不绑定 this）
    const replay = this.replay.bind(this)

    const onEvent = (e: ExecutionEvent) => {
      if (!seen.has(e.id)) queue.push(e)
    }
    emitter.on('event', onEvent)

    return (async function* () {
      try {
        // 断线续传：先回放 afterId 之后的历史
        if (afterId !== undefined) {
          const past = await replay(sessionId, afterId)
          for (const e of past) {
            if (!seen.has(e.id)) {
              seen.add(e.id)
              yield e
            }
          }
        }

        // 实时：队列里积压的先吐 再等新事件
        while (true) {
          const next = queue.shift()
          if (next) {
            if (!seen.has(next.id)) {
              seen.add(next.id)
              yield next
            }
            continue
          }
          // 无积压 等一条新事件
          const e = await new Promise<ExecutionEvent>(resolve => emitter.once('event', resolve))
          if (!seen.has(e.id)) {
            seen.add(e.id)
            yield e
          }
        }
      } finally {
        emitter.off('event', onEvent)
      }
    })()
  }

  /**
   * 回放 afterId 之后的历史事件（断线续传的落库侧）
   */
  async replay(sessionId: number, afterId: number): Promise<ExecutionEvent[]> {
    return this.prisma.executionEvent.findMany({
      where: { sessionId, id: { gt: afterId } },
      orderBy: { id: 'asc' },
    })
  }

  /**
   * 发布流式 delta 到 Redis pub/sub（worker 侧调用）
   * 同步降级模式下不走这里 controller 直接持有 onDelta 写 SSE
   */
  async publishDelta(sessionId: number, delta: string): Promise<void> {
    await this.redis.publish(streamChannel(sessionId), delta)
  }

  /** 发布流结束哨兵（worker 完成或失败后调用 通知 SSE 订阅端关闭连接） */
  async publishStreamEnd(sessionId: number): Promise<void> {
    await this.redis.publish(streamChannel(sessionId), '__done__')
  }

  /**
   * 订阅流式 delta（controller SSE 侧调用 worker 模式下）
   * 独立 subscriber 连接 不占用共享 client 的请求往返
   */
  subscribeDeltas(sessionId: number): AsyncIterable<string> {
    const sub = this.redis.duplicate()
    const channel = streamChannel(sessionId)
    const queue: string[] = []
    let done = false

    sub.on('message', (_ch, message) => {
      if (message === '__done__') {
        done = true
        return
      }
      queue.push(message)
    })

    void sub.subscribe(channel)

    return (async function* () {
      try {
        while (!done || queue.length > 0) {
          const next = queue.shift()
          if (next !== undefined) {
            yield next
            continue
          }
          if (done) return
          await new Promise<void>(resolve => sub.once('message', () => resolve()))
        }
      } finally {
        await sub.unsubscribe(channel)
        sub.disconnect()
      }
    })()
  }

  /** 取或建会话事件发射器 */
  private getEmitter(sessionId: number): EventEmitter {
    let emitter = this.emitters.get(sessionId)
    if (!emitter) {
      emitter = new EventEmitter()
      emitter.setMaxListeners(0)
      this.emitters.set(sessionId, emitter)
    }
    return emitter
  }
}
