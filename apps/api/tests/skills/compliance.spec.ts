import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { ComplianceExecutor, loadWords, matchViolations } from '../../src/skills/executors/builtin/compliance'
import type { WordGroups } from '../../src/skills/executors/builtin/compliance'
import type { SkillCtx } from '../../src/skills/skill-executor'

/** 最小词表 fixture 覆盖三档严重度与重复词条 */
const FIXTURE: WordGroups = {
  绝对化极限用语: [
    { word: '最佳', severity: 'high' },
    { word: '最', severity: 'high' },
  ],
  医疗功效类用语: [{ word: '根治', severity: 'severe' }],
  虚假承诺类: [{ word: '包过', severity: 'medium' }],
}

function makeCtx(): SkillCtx {
  return {
    sessionId: 1,
    employeeId: 2,
    templateSlug: 'compliance',
    configJson: null,
    ctx: { enterpriseId: 1, memberId: 1, role: 'OWNER' },
    emit: async () => undefined,
  }
}

describe('matchViolations 确定性匹配', () => {
  it('命中词条返回 word rule severity 三字段', () => {
    const v = matchViolations('最佳面膜', '化妆品', undefined, FIXTURE)
    expect(v.length).toBeGreaterThan(0)
    const hit = v.find((x) => x.word === '最佳')
    expect(hit).toMatchObject({ word: '最佳', rule: '绝对化极限用语', severity: 'high' })
  })

  it('同一词多处出现只记一条 重复词条去重', () => {
    const v = matchViolations('最佳产品最佳', '最佳类目', undefined, FIXTURE)
    const bestHits = v.filter((x) => x.word === '最佳')
    expect(bestHits).toHaveLength(1)
  })

  it('severe 优先级最高排在前面', () => {
    const v = matchViolations('根治 最佳 包过', '保健食品', undefined, FIXTURE)
    expect(v[0]?.severity).toBe('severe')
  })

  it('大小写不敏感匹配英文词条', () => {
    const words: WordGroups = { 第一唯一类用语: [{ word: 'NO.1', severity: 'high' }] }
    const v = matchViolations('no.1 产品', '服饰', undefined, words)
    expect(v).toHaveLength(1)
    expect(v[0]?.word).toBe('NO.1')
  })

  it('无命中返回空数组', () => {
    const v = matchViolations('纯棉 T 恤', '服饰', '舒适透气', FIXTURE)
    expect(v).toHaveLength(0)
  })
})

describe('loadWords 词表读取', () => {
  it('从真实 corpus 读取 words.json 词数大于 0', () => {
    const words = loadWords()
    const total = Object.values(words).reduce((n, arr) => n + arr.length, 0)
    expect(total).toBeGreaterThan(0)
  })

  it('指定 fixture 路径读取', () => {
    // 用真实文件路径 验证指定路径参数生效
    const real = loadWords()
    const again = loadWords(path.resolve(process.cwd(), '../../corpus/compliance/words.json'))
    expect(again).toEqual(real)
  })
})

describe('ComplianceExecutor 执行', () => {
  it('含违禁词标题返回 passed=false 与命中列表', async () => {
    const executor = new ComplianceExecutor()
    const r = await executor.run(
      { title: '最好用的面膜 无效退款', category: '化妆品', description: '三天即愈' },
      makeCtx(),
    )
    const output = r.output as { violations: unknown[]; passed: boolean }
    expect(output.passed).toBe(false)
    expect(output.violations.length).toBeGreaterThan(0)
    expect(r.summary).toContain('违规')
  })

  it('干净标题 passed=true 无命中', async () => {
    const executor = new ComplianceExecutor()
    const r = await executor.run(
      { title: '纯棉宽松短袖', category: '服饰', description: '日常休闲' },
      makeCtx(),
    )
    const output = r.output as { violations: unknown[]; passed: boolean }
    expect(output.passed).toBe(true)
    expect(output.violations).toHaveLength(0)
  })
})
