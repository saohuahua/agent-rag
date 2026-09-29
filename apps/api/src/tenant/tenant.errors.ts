import { HttpException, HttpStatus } from '@nestjs/common'

/**
 * 租户隔离错误：无租户上下文却访问了需要隔离的数据
 * 语义 500 但更准确地说是「Guard 没接对」的编程错误 服务端缺陷而非客户端问题
 * 为什么不是 401/403：require() 抛它代表链路配置错误 应立刻暴露而非糊给客户端
 */
export class TenantIsolationError extends HttpException {
  constructor(message = 'tenant context missing: guard not wired or called outside request') {
    super({ code: 'TenantIsolation', message }, HttpStatus.INTERNAL_SERVER_ERROR)
  }
}

/** 越权访问其它企业资源 语义 403 */
export class TenantForbiddenError extends HttpException {
  constructor(message = 'forbidden: resource belongs to another tenant') {
    super({ code: 'TenantForbidden', message }, HttpStatus.FORBIDDEN)
  }
}

/** 租户内资源不存在（经隔离过滤后查不到）语义 404 */
export class TenantNotFoundError extends HttpException {
  constructor(message = 'resource not found in current tenant') {
    super({ code: 'TenantNotFound', message }, HttpStatus.NOT_FOUND)
  }
}

/** 租户内资源冲突（重复订阅/重复部门路径等）语义 409 */
export class TenantConflictError extends HttpException {
  constructor(message: string) {
    super({ code: 'TenantConflict', message }, HttpStatus.CONFLICT)
  }
}

/** 租户业务状态非法（如 PUBLISHED 不可改/订阅已取消）语义 400 */
export class TenantInvalidStateError extends HttpException {
  constructor(message: string) {
    super({ code: 'TenantInvalidState', message }, HttpStatus.BAD_REQUEST)
  }
}

/** 认证失败（JWT 无效/过期/口令错）语义 401 */
export class TenantUnauthorizedError extends HttpException {
  constructor(message = 'unauthorized') {
    super({ code: 'TenantUnauthorized', message }, HttpStatus.UNAUTHORIZED)
  }
}
