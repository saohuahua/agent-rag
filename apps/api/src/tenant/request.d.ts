import type { TenantCtx } from '@agent-rag/shared'

/**
 * Express Request 类型扩展：member.guard 鉴权成功后挂载租户上下文与 userId
 * tenant-context.interceptor 读取 tenantCtx 进入 ALS 业务代码可安全读取
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** 已鉴权租户上下文 无则 undefined（未挂 guard 或未登录） */
      tenantCtx?: TenantCtx
      /** JWT sub 即自然人 User.id 无则 undefined */
      userId?: number
    }
  }
}

export {}
