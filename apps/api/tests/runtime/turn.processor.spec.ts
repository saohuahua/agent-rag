import { beforeEach, describe, expect, it, vi } from 'vitest'

// 提前 mock streamText 避免 E2E 真实网络调用 只验证 turn 编排逻辑
vi.mock('ai', () => ({
  streamText: vi.fn(),
}))

import { streamText } from 'ai'
import { TurnProcessor } from '../../src/runtime/turn.processor'
import { LockBusyError } from '../../src/runtime/runtime.errors'
import type { SessionLockService } from '../../src/runtime/session-lock.service'
import type { ContextBuilder } from '../../src/runtime/context-builder'
import type { ToolboxService } from '../../src/runtime/toolbox'
import type { EventsService } from '../../src/runtime/events.service'
import type { SessionService } from '../../src/runtime/session.service'
import type { ChatModelResolver } from '../../src/runtime/agent-model'
import type { PrismaService } from '../../src/prisma/prisma.service'
import type { TenantCtx } from '@agent-rag/shared'

/** 造一个假的 streamText 结果 只含 textStream 与 usage */
function fakeStream(chunks: string[]) {
  const textStream = (async function* () {
    for (const c of chunks) yield c
  })()
  return { textStream, usage: Promise.resolve({ inputTokens: 1, outputTokens: 2 }) }
}

/** 组装 TurnProcessor 与全部假依赖 */
function makeProcessor() {
  const state = { epoch: 0 }

  const prisma = { conversationSession: { update: vi.fn().mockResolvedValue({}) } }
  const lock = {
    tryAcquire: vi.fn().mockResolvedValue('tok'),
    bumpEpoch: vi.fn().mockImplementation(async () => ++state.epoch),
    guardEpoch: vi.fn().mockImplementation(async (_s: number, _e: number, write: (tx: unknown) => Promise<unknown>) =>
      write({ conversationMessage: { create: vi.fn().mockResolvedValue({}) } }),
    ),
    startWatchdog: vi.fn().mockReturnValue(() => {}),
    release: vi.fn().mockResolvedValue(true),
    handover: vi.fn().mockResolvedValue(99),
  }
  const contextBuilder = { build: vi.fn().mockResolvedValue({ system: '你是客服', messages: [] }) }
  const toolbox = {
    toolDescriptions: vi.fn().mockReturnValue(['kb_search: 检索']),
    build: vi.fn().mockReturnValue({}),
  }
  const events = {
    emit: vi.fn().mockResolvedValue({ id: 1 }),
    publishDelta: vi.fn().mockResolvedValue(undefined),
    publishStreamEnd: vi.fn().mockResolvedValue(undefined),
  }
  const sessions = {
    resolveTurnContext: vi.fn().mockResolvedValue({
      sessionId: 1,
      enterpriseId: 1,
      employeeId: 2,
      templateSlug: 'rule-qa',
      systemPrompt: '你是客服',
      kbInject: false,
      skillConfigs: new Map(),
    }),
    loadHistory: vi.fn().mockResolvedValue([{ role: 'user', content: '上一条消息' }]),
    takeover: vi.fn(),
  }
  const modelResolver = { resolve: vi.fn().mockResolvedValue({ provider: 'deepseek', modelId: 'deepseek-flash' }) }

  const processor = new TurnProcessor(
    prisma as unknown as PrismaService,
    lock as unknown as SessionLockService,
    contextBuilder as unknown as ContextBuilder,
    toolbox as unknown as ToolboxService,
    events as unknown as EventsService,
    sessions as unknown as SessionService,
    modelResolver as unknown as ChatModelResolver,
  )

  return { processor, prisma, lock, contextBuilder, toolbox, events, sessions, modelResolver, state }
}

const ctx: TenantCtx = { enterpriseId: 1, memberId: 10, role: 'MEMBER' }

describe('turn 主流程 同步降级模式端到端', () => {
  beforeEach(() => {
    vi.mocked(streamText).mockReset()
  })

  it('八步走通：锁→epoch→消息×2→流→TURN_START/TURN_END→释放锁', async () => {
    vi.mocked(streamText).mockReturnValue(fakeStream(['你好', '，世界']) as unknown as ReturnType<typeof streamText>)

    const { processor, lock, events, sessions } = makeProcessor()
    const deltas: string[] = []

    const outcome = await processor.processSync(1, '你好', ctx, async d => {
      deltas.push(d)
    })

    expect(outcome.assistantText).toBe('你好，世界')
    expect(deltas).toEqual(['你好', '，世界'])

    // 锁与 epoch
    expect(lock.tryAcquire).toHaveBeenCalledWith(1)
    expect(lock.bumpEpoch).toHaveBeenCalledWith(1)
    expect(lock.startWatchdog).toHaveBeenCalledWith(1, 'tok')
    expect(lock.release).toHaveBeenCalledWith(1, 'tok')

    // user + assistant 两条消息都走 epoch fencing
    expect(lock.guardEpoch).toHaveBeenCalledTimes(2)

    // 上下文组装收到历史与工具清单
    expect(sessions.loadHistory).toHaveBeenCalledWith(1)
    expect(sessions.resolveTurnContext).toHaveBeenCalledWith(1, 1)

    // 事件时间线 TURN_START → TURN_END
    const types = (events.emit as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0].type)
    expect(types).toEqual(['TURN_START', 'TURN_END'])
  })

  it('锁被占用时发 LOCK_WAIT 并抛 LockBusyError 不写消息', async () => {
    const { processor, lock, events } = makeProcessor()
    lock.tryAcquire.mockResolvedValueOnce(null)

    await expect(processor.processSync(1, 'hi', ctx, async () => {})).rejects.toBeInstanceOf(LockBusyError)

    expect(events.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'LOCK_WAIT' }))
    expect(lock.guardEpoch).not.toHaveBeenCalled()
    expect(lock.release).not.toHaveBeenCalled()
  })

  it('消息落库：user/assistant 都带 partsJson 与 epoch（roundtrip 可回放）', async () => {
    vi.mocked(streamText).mockReturnValue(fakeStream(['答']) as unknown as ReturnType<typeof streamText>)

    const { processor, lock } = makeProcessor()

    // 记录 guardEpoch 的写回调 用假 tx 捕获 message.create 入参
    const creates: Array<Record<string, unknown>> = []
    const guardEpoch = lock.guardEpoch as unknown as { mockImplementation: (fn: (s: number, e: number, write: (tx: unknown) => Promise<unknown>) => Promise<unknown>) => void }
    guardEpoch.mockImplementation(async (_s, _e, write) => {
      const fakeTx = {
        conversationMessage: {
          create: (arg: Record<string, unknown>) => {
            creates.push(arg)
            return Promise.resolve({})
          },
        },
      }
      return write(fakeTx)
    })

    await processor.processSync(1, '问', ctx, async () => {})

    expect(creates).toHaveLength(2)
    expect(creates[0]).toMatchObject({
      data: { role: 'USER', text: '问', epoch: 1, partsJson: [{ type: 'text', text: '问' }] },
    })
    expect(creates[1]).toMatchObject({
      data: { role: 'ASSISTANT', text: '答', employeeId: 2, epoch: 1, partsJson: [{ type: 'text', text: '答' }] },
    })
  })
})
