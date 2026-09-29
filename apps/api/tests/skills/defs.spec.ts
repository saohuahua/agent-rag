import { describe, expect, it } from 'vitest'
import { SKILL_DEFS } from '../../src/skills/defs'

/** 断言 helper 合法输入通过 非法输入被拒 */
function expectValid(def: (typeof SKILL_DEFS)[number], input: unknown): void {
  expect(def.inputSchema.safeParse(input).success).toBe(true)
}

function expectInvalid(def: (typeof SKILL_DEFS)[number], input: unknown): void {
  expect(def.inputSchema.safeParse(input).success).toBe(false)
}

describe('技能定义清单', () => {
  it('上架 7 个技能 不含 conversation.handover（runtime 内置）', () => {
    expect(SKILL_DEFS).toHaveLength(7)
    const keys = SKILL_DEFS.map((d) => d.key)
    expect(keys).toEqual([
      'kb_search',
      'compliance_check',
      'batch_scan',
      'ticket_classify',
      'operate_ticket',
      'run_readonly_sql',
      'consult_creative_agent',
    ])
    expect(keys).not.toContain('conversation.handover')
  })

  it('三种执行器类型都覆盖', () => {
    const types = new Set(SKILL_DEFS.map((d) => d.type))
    expect(types).toEqual(new Set(['BUILTIN_FUNCTION', 'HTTP_RPA', 'EXTERNAL_AGENT']))
  })
})

describe('kb_search 输入校验', () => {
  const def = SKILL_DEFS.find((d) => d.key === 'kb_search')!

  it('合法 query 通过', () => expectValid(def, { query: '七天无理由退货规则' }))
  it('带 topK 通过', () => expectValid(def, { query: '价保', topK: 10 }))
  it('空 query 拒绝', () => expectInvalid(def, { query: '' }))
  it('topK 超上限拒绝', () => expectInvalid(def, { query: 'x', topK: 21 }))
})

describe('compliance_check 输入校验', () => {
  const def = SKILL_DEFS.find((d) => d.key === 'compliance_check')!

  it('合法标题与类目通过', () => expectValid(def, { title: '纯棉 T 恤', category: '服饰' }))
  it('可空描述通过', () => expectValid(def, { title: 'x', category: 'y', description: 'z' }))
  it('空标题拒绝', () => expectInvalid(def, { title: '', category: '服饰' }))
  it('空类目拒绝', () => expectInvalid(def, { title: 'x', category: '' }))
})

describe('batch_scan 输入校验', () => {
  const def = SKILL_DEFS.find((d) => d.key === 'batch_scan')!

  it('合法商品列表通过', () => expectValid(def, { productIds: ['p1', 'p2'] }))
  it('空列表拒绝', () => expectInvalid(def, { productIds: [] }))
  it('含空字符串拒绝', () => expectInvalid(def, { productIds: [''] }))
})

describe('ticket_classify 输入校验', () => {
  const def = SKILL_DEFS.find((d) => d.key === 'ticket_classify')!

  it('合法工单文本通过', () => expectValid(def, { ticketText: '商品破损申请退款' }))
  it('空文本拒绝', () => expectInvalid(def, { ticketText: '' }))
})

describe('operate_ticket 输入校验', () => {
  const def = SKILL_DEFS.find((d) => d.key === 'operate_ticket')!

  it('合法操作通过', () => expectValid(def, { ticketId: 't1', action: 'refund' }))
  it('带备注通过', () => expectValid(def, { ticketId: 't1', action: 'escalate', note: '升级处理' }))
  it('非法 action 拒绝', () => expectInvalid(def, { ticketId: 't1', action: 'delete' }))
  it('空 ticketId 拒绝', () => expectInvalid(def, { ticketId: '', action: 'refund' }))
})

describe('run_readonly_sql 输入校验', () => {
  const def = SKILL_DEFS.find((d) => d.key === 'run_readonly_sql')!

  it('合法问题与 SQL 通过', () => expectValid(def, { question: '查订单', sql: 'SELECT * FROM orders' }))
  it('空 SQL 拒绝', () => expectInvalid(def, { question: 'q', sql: '' }))
})

describe('consult_creative_agent 输入校验', () => {
  const def = SKILL_DEFS.find((d) => d.key === 'consult_creative_agent')!

  it('合法简报通过', () => expectValid(def, { brief: '双十一大促活动创意' }))
  it('空简报拒绝', () => expectInvalid(def, { brief: '' }))
})
