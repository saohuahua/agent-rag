/**
 * 工单领域类型与常量
 * 状态机四态 OPEN 起始 PROCESSING 中间 RESOLVED REJECTED 终态
 * 为什么用字符串字面量联合类型: 编译期穷尽检查 状态流转不会拼错单词
 */

// 工单状态 顺序即生命周期顺序
export const TICKET_STATUSES = ['OPEN', 'PROCESSING', 'RESOLVED', 'REJECTED'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

// 售后类型 退款 退货 换货 投诉 咨询
export const ISSUE_TYPES = ['REFUND', 'RETURN', 'EXCHANGE', 'COMPLAINT', 'CONSULT'] as const
export type IssueType = (typeof ISSUE_TYPES)[number]

// 优先级 从低到高
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export type Priority = (typeof PRIORITIES)[number]

// 批量标记操作模式 添加标记或移除标记
export const TAG_MODES = ['add', 'remove'] as const
export type TagMode = (typeof TAG_MODES)[number]

/**
 * 工单实体 模拟电商售后工单
 * refundAmount 单位是分 整数 避免浮点金额误差
 */
export interface Ticket {
  // 工单号 形如 T0001
  id: string
  // 店铺 id
  shopId: string
  // 店铺名 展示用
  shopName: string
  // 关联订单号
  orderNo: string
  // 商品名 种子数据里埋了一些广告法违禁词 供后续风险扫描演示
  productName: string
  // 买家昵称
  buyerNick: string
  // 售后类型
  issueType: IssueType
  // 当前状态
  status: TicketStatus
  // 优先级
  priority: Priority
  // 人工或 RPA 打的标记
  tags: string[]
  // 退款金额 单位分 非退款单为 null
  refundAmount: number | null
  // 是否已退款
  refunded: boolean
  // 问题描述
  description: string
  // 创建时间 ISO 8601
  createdAt: string
  // 最后更新时间 ISO 8601
  updatedAt: string
}

/**
 * 状态机流转表 键是当前态 值是可达的目标态集合
 * 非法流转一律拒绝 保证业务状态可控
 */
export const ALLOWED_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ['PROCESSING'],
  PROCESSING: ['RESOLVED', 'REJECTED'],
  RESOLVED: [],
  REJECTED: [],
}
