import { describe, expect, it } from 'vitest'
import { chunkBlocks } from '../../src/rag/chunker'
import type { TextBlock } from '../../src/rag/parser/types'

/** 生成 n 个可区分字符的测试串 每个字符由位置唯一决定 便于校验重叠 */
function genText(n: number): string {
  return Array.from({ length: n }, (_, i) => String.fromCharCode(0x4e00 + (i % 100))).join('')
}

describe('结构感知分块', () => {
  it('长文 1300 字切成 600 600 300 三段', () => {
    const text = genText(1300)
    const chunks = chunkBlocks([{ text, page: 1, headingPath: null, isTable: false }])

    expect(chunks.map(c => c.content.length)).toEqual([600, 600, 300])
  })

  it('相邻块重叠 100 后块开头等于前块末尾 100 字', () => {
    const text = genText(1300)
    const chunks = chunkBlocks([{ text, page: null, headingPath: null, isTable: false }])

    expect(chunks[1]!.content.slice(0, 100)).toBe(chunks[0]!.content.slice(-100))
    expect(chunks[2]!.content.slice(0, 100)).toBe(chunks[1]!.content.slice(-100))
  })

  it('600±100 容差内 满块正好 600 尾块不足 600', () => {
    const text = genText(900)
    const chunks = chunkBlocks([{ text, page: null, headingPath: null, isTable: false }])

    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(700)
      expect(c.content.length).toBeGreaterThanOrEqual(0)
    }
    // 满块 600 尾块 400（900 → 600 + 400）
    expect(chunks.map(c => c.content.length)).toEqual([600, 400])
  })

  it('表格整块原子 前缀 [表格] 不与相邻段落合并', () => {
    const blocks: TextBlock[] = [
      { text: '第一段正文', page: null, headingPath: null, isTable: false },
      { text: '商品类型 | 退货时限', page: null, headingPath: null, isTable: true },
      { text: '第二段正文', page: null, headingPath: null, isTable: false },
    ]
    const chunks = chunkBlocks(blocks)

    expect(chunks.map(c => c.content)).toEqual([
      '第一段正文',
      '[表格] 商品类型 | 退货时限',
      '第二段正文',
    ])
  })

  it('headingPath 序列化为 斜杠分隔', () => {
    const chunks = chunkBlocks([{ text: '正文', page: null, headingPath: ['第一章', '退款规则'], isTable: false }])

    expect(chunks[0]!.headingPath).toBe('第一章 / 退款规则')
  })

  it('相邻块合并时 headingPath 取起始块标题', () => {
    const blocks: TextBlock[] = [
      { text: '标题文本', page: null, headingPath: ['第一章'], isTable: false },
      { text: '正文内容', page: null, headingPath: ['第一章', '退款规则'], isTable: false },
    ]
    const chunks = chunkBlocks(blocks)

    expect(chunks.length).toBe(1)
    expect(chunks[0]!.content).toBe('标题文本 正文内容')
    expect(chunks[0]!.headingPath).toBe('第一章')
  })

  it('多块合并用空格连接 短块聚合进一个块', () => {
    const blocks: TextBlock[] = [
      { text: 'a'.repeat(250), page: 1, headingPath: null, isTable: false },
      { text: 'b'.repeat(250), page: 1, headingPath: null, isTable: false },
    ]
    const chunks = chunkBlocks(blocks)

    expect(chunks.length).toBe(1)
    expect(chunks[0]!.content).toBe(`${'a'.repeat(250)} ${'b'.repeat(250)}`)
    expect(chunks[0]!.page).toBe(1)
  })
})
