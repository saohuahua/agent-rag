import { Injectable } from '@nestjs/common'
import type { TenantCtx } from '@agent-rag/shared'

/**
 * [桩] 任务 D 将替换为真实现（契约见 10-骨架/04 §6）
 * 请求级租户上下文载体（AsyncLocalStorage）
 */
@Injectable()
export class EnterpriseContextService {
  /** 在指定上下文中执行 fn（ALS enter/exit）worker 与脚本用 */
  run<T>(ctx: TenantCtx, fn: () => Promise<T>): Promise<T> {
    throw new Error('NOT_IMPLEMENTED: context.run (任务D)')
  }

  /** 当前上下文（无则 null）请求处理链路用 */
  current(): TenantCtx | null {
    throw new Error('NOT_IMPLEMENTED: context.current (任务D)')
  }

  /** 必须有上下文否则抛 TenantIsolationError（拿到即说明 Guard 没接对） */
  require(): TenantCtx {
    throw new Error('NOT_IMPLEMENTED: context.require (任务D)')
  }
}
