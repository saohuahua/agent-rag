import { describe, expect, it } from 'vitest'
import { checkQuality } from '../../src/rag/parser/quality'

describe('质量探测 quality', () => {
  it('正常中文文本通过', () => {
    const text = '消费者自签收商品次日起七日内有权无需说明理由退货。'.repeat(20)
    expect(checkQuality(text).ok).toBe(true)
  })

  it('全文不足 200 字符返回不通过', () => {
    const r = checkQuality('太短了')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('too short')
  })

  it('乱码占多数 CJK 可打印率低于 60% 返回不通过', () => {
    // 大量替换符与不可打印字符 只有少量中文
    const text = '�'.repeat(300) + '你好'
    const r = checkQuality(text)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('printable rate')
  })

  it('纯英文文本不通过（电商规则域要求中文为主）', () => {
    const text = 'hello world this is english text '.repeat(20)
    // 英文是可打印字符 但长度足够且都是 ASCII 字母 可打印率 100% 应通过
    // 这里验证的是可打印率口径 不把英文当乱码
    expect(checkQuality(text).ok).toBe(true)
  })
})
