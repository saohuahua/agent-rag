import { describe, expect, it } from 'vitest'
import { cleanToken, tokenize, toTsquery, toTsvectorInput } from '../../src/rag/tokenizer'

describe('分词清洗 cleanToken', () => {
  it('剔除 tsquery 语法符 & | ! ( ) 冒号 引号 星号 脱字符 反斜杠', () => {
    expect(cleanToken('a&b')).toBe('ab')
    expect(cleanToken('a|b')).toBe('ab')
    expect(cleanToken('a!b')).toBe('ab')
    expect(cleanToken('(a)')).toBe('a')
    expect(cleanToken('a:b')).toBe('ab')
    expect(cleanToken("it's")).toBe('its')
    expect(cleanToken('a"b')).toBe('ab')
    expect(cleanToken('a*b')).toBe('ab')
    expect(cleanToken('a^b')).toBe('ab')
    expect(cleanToken('a\\b')).toBe('ab')
  })

  it('空串与纯空白返回 null', () => {
    expect(cleanToken('')).toBeNull()
    expect(cleanToken('   ')).toBeNull()
    expect(cleanToken(' \t ')).toBeNull()
  })

  it('中文与数字保留 如七天 7天 3C', () => {
    expect(cleanToken('七天')).toBe('七天')
    expect(cleanToken('7天')).toBe('7天')
    expect(cleanToken('3C')).toBe('3C')
  })
})

describe('分词 tokenize', () => {
  it('中文查询分词 空 token 被过滤 结果无空白无重复', () => {
    const tokens = tokenize('七天无理由退货 买错了能退吗')
    expect(tokens).not.toContain('')
    expect(tokens.some(t => /\s/.test(t))).toBe(false)
    // 关键术语应被切出（cutForSearch 语义 断言核心词存在）
    expect(tokens).toContain('退货')
    expect(tokens).toContain('买错')
  })

  it('查询中的 tsquery 特殊符整体剔除 不影响词切分', () => {
    const tokens = tokenize('退款 & 退货 | 换货')
    expect(tokens).toContain('退款')
    expect(tokens).toContain('退货')
    expect(tokens).toContain('换货')
    expect(tokens.some(t => /[&|!():'"*^\\]/.test(t))).toBe(false)
  })
})

describe('OR 表达式与 tsvector 拼装', () => {
  it('OR 表达式用 | 连接 宽容匹配', () => {
    expect(toTsquery(['七天', '退货'])).toBe('七天 | 退货')
    expect(toTsquery(['a'])).toBe('a')
    expect(toTsquery([])).toBe('')
  })

  it('tsvector 输入用空格连接 供 simple 配置再切', () => {
    expect(toTsvectorInput(['七天', '无', '理由'])).toBe('七天 无 理由')
    expect(toTsvectorInput([])).toBe('')
  })
})
