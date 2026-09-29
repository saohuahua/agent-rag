import { describe, expect, it, vi } from 'vitest'
import { ContextBuilder } from '../../src/runtime/context-builder'
import { RetrievalService } from '../../src/rag/retrieval.service'
import type { HistoryMessage } from '../../src/runtime/context-builder'

/** 造假检索 返回两条命中 */
function fakeRetrieval() {
  const hybridSearch = vi.fn().mockResolvedValue([
    { chunkId: 1, docId: 1, content: '七天无理由退货', rrfScore: 0.9 },
    { chunkId: 2, docId: 1, content: '退款到账时间 3-7 天', rrfScore: 0.8 },
  ])
  return { retrieval: { hybridSearch } as unknown as RetrievalService, hybridSearch }
}

/** 造 45 条历史消息 触发截断 */
function longHistory(): HistoryMessage[] {
  return Array.from({ length: 45 }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `消息 ${i}`,
  }))
}

describe('上下文组装', () => {
  it('system 三段：模板 + INJECT 检索片段 + 工具清单', async () => {
    const { retrieval, hybridSearch } = fakeRetrieval()
    const builder = new ContextBuilder(retrieval)

    const built = await builder.build({
      enterpriseId: 1,
      systemPrompt: '你是规则客服',
      kbInject: true,
      query: '退货政策',
      history: [],
      toolDescriptions: ['kb_search: 检索知识库'],
    })

    expect(built.system).toContain('你是规则客服')
    expect(built.system).toContain('七天无理由退货')
    expect(built.system).toContain('[1]')
    expect(built.system).toContain('kb_search')
    expect(hybridSearch).toHaveBeenCalledWith({ enterpriseId: 1, query: '退货政策', topK: 3, channel: 'auto' })
  })

  it('kbInject=false 不检索 不拼片段', async () => {
    const { retrieval, hybridSearch } = fakeRetrieval()
    const builder = new ContextBuilder(retrieval)

    const built = await builder.build({
      enterpriseId: 1,
      systemPrompt: '你是客服',
      kbInject: false,
      query: 'x',
      history: [],
      toolDescriptions: [],
    })

    expect(built.system).not.toContain('知识库检索结果')
    expect(hybridSearch).not.toHaveBeenCalled()
  })

  it('历史超 40 条截断 保留最近 40 且回调 dropped', async () => {
    const { retrieval } = fakeRetrieval()
    const builder = new ContextBuilder(retrieval)

    const onTruncate = vi.fn()
    const built = await builder.build({
      enterpriseId: 1,
      systemPrompt: 'sys',
      kbInject: false,
      query: 'x',
      history: longHistory(),
      toolDescriptions: [],
      onTruncate,
    })

    expect(built.messages).toHaveLength(40)
    expect(onTruncate).toHaveBeenCalledWith(5)
    // 保留的是最近 40 条 首条应为原第 6 条（下标 5）
    expect(built.messages[0]?.content).toBe('消息 5')
  })

  it('历史转 ModelMessage 角色正确', async () => {
    const { retrieval } = fakeRetrieval()
    const builder = new ContextBuilder(retrieval)

    const built = await builder.build({
      enterpriseId: 1,
      systemPrompt: 'sys',
      kbInject: false,
      query: 'x',
      history: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '在的' },
      ],
      toolDescriptions: [],
    })

    expect(built.messages).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在的' },
    ])
  })
})
