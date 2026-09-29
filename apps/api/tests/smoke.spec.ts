import { describe, expect, it } from 'vitest'
import { ChatTurnRequestSchema, SkillTypes } from '@agent-rag/shared'

/**
 * 冒烟测试：验证 workspace 共享包链接与基础 DTO 行为
 * 同时证明 vitest 基线可用（后续任务各自扩充自己目录的测试）
 */
describe('共享包基线', () => {
  it('ChatTurnRequest 合法输入应解析成功', () => {
    const r = ChatTurnRequestSchema.parse({ sessionId: 1, message: '你好' })
    expect(r.sessionId).toBe(1)
    expect(r.message).toBe('你好')
  })

  it('ChatTurnRequest 空消息应被拒绝', () => {
    expect(() => ChatTurnRequestSchema.parse({ sessionId: 1, message: '' })).toThrow()
  })

  it('ChatTurnRequest 非正整数 sessionId 应被拒绝', () => {
    expect(() => ChatTurnRequestSchema.parse({ sessionId: -1, message: 'x' })).toThrow()
  })

  it('技能三类型常量与 Prisma 枚举对齐', () => {
    expect(SkillTypes).toHaveLength(3)
    expect(SkillTypes).toContain('HTTP_RPA')
  })
})
