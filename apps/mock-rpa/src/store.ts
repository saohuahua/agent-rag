/**
 * 内存工单存储
 * 为什么用内存 Map 而不是 sqlite: mock 服务要求重启回种子 内存天然可复现 且零外部依赖
 * 所有读方法返回深拷贝 防止路由层误改内部状态
 */
import { AppError } from './errors'
import { ALLOWED_TRANSITIONS } from './types'
import type { Ticket, TicketStatus, TagMode } from './types'

// 列表过滤条件 按店铺或按状态可选
export interface ListFilter {
  shopId?: string
  status?: TicketStatus
}

// 分页列表结果
export interface ListResult {
  items: Ticket[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

// 批量操作结果 已处理 未找到 被拒 三组
export interface BatchResult {
  updated: string[]
  missing: string[]
  rejected: Array<{ id: string; reason: string }>
}

export class TicketStore {
  // 内存 Map 主键是工单号
  private readonly tickets = new Map<string, Ticket>()

  /**
   * @param seeds 种子工单 构造时全量写入
   */
  constructor(seeds: Ticket[]) {
    for (const s of seeds) {
      this.tickets.set(s.id, this.clone(s))
    }
  }

  // 深拷贝 数组字段单独复制 防外部改引用破坏内部状态
  private clone(t: Ticket): Ticket {
    return { ...t, tags: [...t.tags] }
  }

  /**
   * 当前工单总数 供 healthz 展示
   */
  count(): number {
    return this.tickets.size
  }

  /**
   * 按 id 取单条 不存在返回 undefined 由路由层转 404
   * @param id 工单号
   */
  get(id: string): Ticket | undefined {
    const t = this.tickets.get(id)
    return t ? this.clone(t) : undefined
  }

  /**
   * 分页列表 先过滤再按 id 升序排序 保证分页结果稳定
   * @param filter 按店铺或按状态的过滤条件
   * @param page 页码 从 1 开始
   * @param pageSize 每页条数
   */
  list(filter: ListFilter, page: number, pageSize: number): ListResult {
    let all = [...this.tickets.values()]

    if (filter.shopId) {
      all = all.filter((t) => t.shopId === filter.shopId)
    }
    if (filter.status) {
      all = all.filter((t) => t.status === filter.status)
    }

    all.sort((a, b) => a.id.localeCompare(b.id))

    const total = all.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const start = (page - 1) * pageSize
    const items = all.slice(start, start + pageSize).map((t) => this.clone(t))

    return { items, total, page, pageSize, totalPages }
  }

  /**
   * 状态流转 严格校验状态机 非法流转抛 409
   * @param id 工单号
   * @param to 目标状态
   */
  transition(id: string, to: TicketStatus): Ticket {
    const t = this.tickets.get(id)
    if (!t) {
      throw new AppError('TICKET_NOT_FOUND', 404, `ticket ${id} not found`)
    }

    const allowed = ALLOWED_TRANSITIONS[t.status] ?? []
    if (!allowed.includes(to)) {
      throw new AppError('INVALID_TRANSITION', 409, `cannot transition ${id} from ${t.status} to ${to}`)
    }

    t.status = to
    t.updatedAt = new Date().toISOString()
    return this.clone(t)
  }

  /**
   * 批量标记 部分成功语义 未找到的 id 收进 missing 不整体失败
   * @param ids 工单号数组
   * @param tags 标记数组
   * @param mode add 添加 remove 移除
   */
  batchTag(ids: string[], tags: string[], mode: TagMode): BatchResult {
    const result: BatchResult = { updated: [], missing: [], rejected: [] }

    for (const id of ids) {
      const t = this.tickets.get(id)
      if (!t) {
        result.missing.push(id)
        continue
      }

      if (mode === 'add') {
        for (const tag of tags) {
          if (!t.tags.includes(tag)) {
            t.tags.push(tag)
          }
        }
      } else {
        t.tags = t.tags.filter((x) => !tags.includes(x))
      }

      t.updatedAt = new Date().toISOString()
      result.updated.push(id)
    }

    return result
  }

  /**
   * 批量退款 要求工单处于 PROCESSING 退款完成自动置 RESOLVED
   * 为什么退款要求 PROCESSING: 退款是售后动作 必须先进入处理中 未处理的单不能直接退
   * @param ids 工单号数组
   * @param amount 退款金额 单位分 缺省用工单已有金额否则 0
   */
  batchRefund(ids: string[], amount?: number): BatchResult {
    const result: BatchResult = { updated: [], missing: [], rejected: [] }

    for (const id of ids) {
      const t = this.tickets.get(id)
      if (!t) {
        result.missing.push(id)
        continue
      }

      if (t.status !== 'PROCESSING') {
        result.rejected.push({ id, reason: `ticket ${id} is ${t.status} refund requires PROCESSING` })
        continue
      }

      t.refunded = true
      t.refundAmount = amount ?? t.refundAmount ?? 0
      t.status = 'RESOLVED'
      t.updatedAt = new Date().toISOString()
      result.updated.push(id)
    }

    return result
  }
}
