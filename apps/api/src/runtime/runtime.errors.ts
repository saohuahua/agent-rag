import { HttpException, HttpStatus } from '@nestjs/common'

/**
 * 会话锁已被他人持有
 * 语义：效率锁冲突 非正确性问题 调用方（turn.processor）捕获后抛给 BullMQ 触发重排
 * 正确性由 DB epoch 兜底 见 session-lock.service.ts 头注释
 */
export class LockBusyError extends Error {
  readonly code = 'LOCK_BUSY'

  constructor(sessionId: number) {
    super(`session ${sessionId} lock held by another worker`)
    this.name = 'LockBusyError'
  }
}

/**
 * epoch 过期：旧持有者迟到写被拒
 * fencing token 兜底 正确性不依赖锁的正确性 见 session-lock.service.ts 头注释
 */
export class StaleEpochError extends Error {
  readonly code = 'STALE_EPOCH'

  constructor(sessionId: number, mine: number, current: number) {
    super(`session ${sessionId} epoch ${mine} stale current ${current}`)
    this.name = 'StaleEpochError'
  }
}

/** handover 目标不在会话阵容 语义 400 */
export class HandoverTargetError extends HttpException {
  constructor(target: string) {
    super(
      { code: 'HANDOVER_TARGET_INVALID', message: `handover target not in session roster: ${target}` },
      HttpStatus.BAD_REQUEST,
    )
  }
}

/** 会话不存在 语义 404 */
export class SessionNotFoundError extends HttpException {
  constructor(sessionId: number) {
    super({ code: 'SESSION_NOT_FOUND', message: `session ${sessionId} not found` }, HttpStatus.NOT_FOUND)
  }
}

/** 无权访问会话（企业隔离或成员无授权）语义 403 */
export class SessionAccessDeniedError extends HttpException {
  constructor(sessionId: number) {
    super({ code: 'SESSION_ACCESS_DENIED', message: `access denied to session ${sessionId}` }, HttpStatus.FORBIDDEN)
  }
}

/** 会话阵容为空或不合法 语义 400 */
export class InvalidRosterError extends HttpException {
  constructor(reason: string) {
    super({ code: 'INVALID_ROSTER', message: reason }, HttpStatus.BAD_REQUEST)
  }
}
