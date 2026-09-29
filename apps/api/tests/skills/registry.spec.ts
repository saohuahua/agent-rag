import { describe, expect, it, vi } from 'vitest'
import { SkillExecutorRegistry } from '../../src/skills/skill-executor'
import { KbSearchExecutor } from '../../src/skills/executors/builtin/kb-search'
import { ComplianceExecutor } from '../../src/skills/executors/builtin/compliance'
import { TicketClassifyExecutor } from '../../src/skills/executors/builtin/ticket-classify'
import { ReadonlySqlExecutor } from '../../src/skills/executors/builtin/readonly-sql'
import { HttpRpaExecutor } from '../../src/skills/executors/http-rpa'
import { ExternalAgentExecutor } from '../../src/skills/executors/external-agent'
import { SkillInputError } from '../../src/skills/errors'
import type { RetrievalService } from '../../src/rag/retrieval.service'
import type { GatewayService } from '../../src/gateway/gateway.service'
import type { UsageMeterService } from '../../src/gateway/usage-meter.service'
import type { PrismaService } from '../../src/prisma/prisma.service'
import type { SkillCtx } from '../../src/skills/skill-executor'

/** 组装带 mock 依赖的注册表 覆盖三类执行器 */
function buildRegistry() {
  const retrieval = { hybridSearch: vi.fn() } as unknown as RetrievalService
  const gateway = { chat: vi.fn() } as unknown as GatewayService
  const meter = { record: vi.fn().mockResolvedValue(undefined) } as unknown as UsageMeterService
  const prisma = {} as unknown as PrismaService

  const registry = new SkillExecutorRegistry(
    new KbSearchExecutor(retrieval),
    new ComplianceExecutor(),
    new TicketClassifyExecutor(gateway),
    new ReadonlySqlExecutor(prisma),
    new HttpRpaExecutor(meter),
    new ExternalAgentExecutor(gateway, meter),
  )

  return { registry, retrieval, gateway, meter }
}

function makeCtx(): SkillCtx {
  return {
    sessionId: 1,
    employeeId: 2,
    templateSlug: 'service',
    configJson: null,
    ctx: { enterpriseId: 1, memberId: 1, role: 'OWNER' },
    emit: vi.fn().mockResolvedValue(undefined),
  }
}

describe('SkillExecutorRegistry 统一入口', () => {
  it('listDefs 返回 7 个技能', () => {
    const { registry } = buildRegistry()
    expect(registry.listDefs()).toHaveLength(7)
  })

  it('未知技能 key 抛 SkillInputError', async () => {
    const { registry } = buildRegistry()
    await expect(
      registry.execute({ skillKey: 'nope', input: {}, skillCtx: makeCtx() }),
    ).rejects.toBeInstanceOf(SkillInputError)
  })

  it('非法输入抛 SkillInputError 且透出 zod issues', async () => {
    const { registry } = buildRegistry()
    const err = await registry
      .execute({ skillKey: 'kb_search', input: { query: '' }, skillCtx: makeCtx() })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SkillInputError)
    expect((err as SkillInputError).issues).toBeTruthy()
    expect((err as SkillInputError).issues).toBeInstanceOf(Array)
  })
})

describe('kb_search 分发', () => {
  it('直调 RetrievalService 契约 返回截断片段', async () => {
    const { registry, retrieval } = buildRegistry()
    ;(retrieval.hybridSearch as ReturnType<typeof vi.fn>).mockResolvedValue([
      { chunkId: 1, docId: 1, content: 'x'.repeat(500), headingPath: '第三条', rrfScore: 0.9 },
    ])

    const r = await registry.execute({
      skillKey: 'kb_search',
      input: { query: '七天无理由' },
      skillCtx: makeCtx(),
    })

    expect(retrieval.hybridSearch).toHaveBeenCalledWith({
      enterpriseId: 1,
      query: '七天无理由',
      topK: 8,
    })

    const output = r.output as { hits: Array<{ content: string }>; count: number }
    expect(output.count).toBe(1)
    // 内容截断到 300 字符内
    expect(output.hits[0]!.content.length).toBeLessThanOrEqual(300)
    expect(r.summary).toContain('检索到')
  })

  it('缺租户上下文抛 SkillInputError', async () => {
    const { registry } = buildRegistry()
    const ctx = makeCtx()
    ctx.ctx = undefined

    await expect(
      registry.execute({ skillKey: 'kb_search', input: { query: 'x' }, skillCtx: ctx }),
    ).rejects.toBeInstanceOf(SkillInputError)
  })
})

describe('ticket_classify 分发', () => {
  it('结构化输出解析成功 返回枚举字段', async () => {
    const { registry, gateway } = buildRegistry()
    ;(gateway.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: '{"type":"refund","urgency":"high","policyRef":"七天无理由"}',
      usage: {},
    })

    const r = await registry.execute({
      skillKey: 'ticket_classify',
      input: { ticketText: '商品破损申请退款' },
      skillCtx: makeCtx(),
    })

    expect(r.output).toMatchObject({ type: 'refund', urgency: 'high' })
    expect(gateway.chat).toHaveBeenCalledTimes(1)
    // 走 cheap 别名
    const opts = (gateway.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(opts.alias).toBe('chat')
  })

  it('解析失败重试 1 次后成功', async () => {
    const { registry, gateway } = buildRegistry()
    ;(gateway.chat as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ text: '这是无效输出', usage: {} })
      .mockResolvedValueOnce({
        text: '```json\n{"type":"complaint","urgency":"urgent","policyRef":"争议处理规则"}\n```',
        usage: {},
      })

    const r = await registry.execute({
      skillKey: 'ticket_classify',
      input: { ticketText: '投诉' },
      skillCtx: makeCtx(),
    })

    expect(r.output).toMatchObject({ type: 'complaint', urgency: 'urgent' })
    expect(gateway.chat).toHaveBeenCalledTimes(2)
  })
})

describe('consult_creative_agent 分发', () => {
  it('经 strong-chat 起小 agent 返回方案 并记 EXTERNAL_AGENT 账', async () => {
    const { registry, gateway, meter } = buildRegistry()
    ;(gateway.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: '创意方案正文',
      usage: { providerName: 'deepseek', model: 'deepseek-chat', inputTokens: 10, outputTokens: 20 },
    })

    const r = await registry.execute({
      skillKey: 'consult_creative_agent',
      input: { brief: '双十一活动' },
      skillCtx: makeCtx(),
    })

    expect(r.output).toMatchObject({ plan: '创意方案正文' })

    const opts = (gateway.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(opts.alias).toBe('strong-chat')

    // 记账 kind=EXTERNAL_AGENT 成本 0 延迟与 token 真实
    expect(meter.record).toHaveBeenCalledTimes(1)
    const entry = (meter.record as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(entry).toMatchObject({ kind: 'EXTERNAL_AGENT', costCny: 0, success: true })
  })
})
