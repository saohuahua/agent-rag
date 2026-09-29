/**
 * 应用错误类型
 * 为什么继承 Error 而不是 Result/Either: 项目规范统一用 try catch throw 不搞函数式容器
 * code 是英文可搜索错误码 用于 RPA 技能按码做重试或降级
 * status 对应 HTTP 状态码 路由层统一 onError 转响应
 */
export class AppError extends Error {
  // 错误码 英文 全大写 下划线分隔
  readonly code: string
  // 对应的 HTTP 状态码
  readonly status: number

  /**
   * @param code 错误码 如 TICKET_NOT_FOUND
   * @param status HTTP 状态码 如 404
   * @param message 英文错误消息 可搜索
   */
  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
  }
}
