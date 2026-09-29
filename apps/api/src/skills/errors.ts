/**
 * 技能执行错误族 全部继承 Error 带 code（见 10-骨架/03 §5）
 * 错误消息英文可搜索 校验细节透出给 LLM 用于自我纠正
 */

/** 入参非法（zod 校验失败或技能 key 不存在） 语义 4xx 可由 LLM 自我纠正后重试 */
export class SkillInputError extends Error {
  readonly code = 'SkillInput'
  /** zod 校验失败时的 issues 数组 透出给 LLM 看是哪一栏不对 */
  readonly issues?: unknown

  constructor(message: string, issues?: unknown) {
    super(message)
    this.name = 'SkillInputError'
    this.issues = issues
  }
}

/** RPA 外部调用超时中断 走重试 重试耗尽后仍抛出本类 */
export class SkillTimeoutError extends Error {
  readonly code = 'SkillTimeout'

  constructor(message: string) {
    super(message)
    this.name = 'SkillTimeoutError'
  }
}

/** RPA 调用失败（4xx 不重试或 5xx/网络错重试耗尽） status 为 undefined 表示网络层错误 */
export class RpaError extends Error {
  readonly code = 'RpaError'
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'RpaError'
    this.status = status
  }
}
