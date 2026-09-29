import { describe, expect, it } from 'vitest'
import { parseHtml } from '../../src/rag/parser/docx-parser'

describe('docx HTML 解析 parseHtml', () => {
  it('标题层级路径 段落继承最近的标题', () => {
    const blocks = parseHtml('<h1>第一章</h1><p>段落一</p><h2>退款规则</h2><p>段落二</p>')

    // 块序：h1(父路径 null) p(第一章) h2(父第一章) p(第一章/退款规则)
    expect(blocks.map(b => b.text)).toEqual(['第一章', '段落一', '退款规则', '段落二'])
    expect(blocks[0]!.headingPath).toBeNull()
    expect(blocks[1]!.headingPath).toEqual(['第一章'])
    expect(blocks[2]!.headingPath).toEqual(['第一章'])
    expect(blocks[3]!.headingPath).toEqual(['第一章', '退款规则'])
  })

  it('同级标题覆盖 深层标题出栈', () => {
    const blocks = parseHtml('<h1>甲</h1><h2>乙</h2><h2>丙</h2><p>正文</p>')

    expect(blocks[3]!.headingPath).toEqual(['甲', '丙'])
  })

  it('表格整块原子 序列化行内 | 分隔 继承标题', () => {
    const blocks = parseHtml('<h1>规则</h1><table><tr><th>类型</th><th>时限</th></tr><tr><td>普通</td><td>7天</td></tr></table>')

    expect(blocks[1]!.isTable).toBe(true)
    expect(blocks[1]!.text).toBe('类型 | 时限\n普通 | 7天')
    expect(blocks[1]!.headingPath).toEqual(['规则'])
  })

  it('HTML 实体解码', () => {
    const blocks = parseHtml('<p>A&amp;B &lt;规则&gt;</p>')
    expect(blocks[0]!.text).toBe('A&B <规则>')
  })
})
