/**
 * 入参 zod 校验 schema
 * 所有接口入参先过 schema 再进业务 非法直接 400
 * 为什么 query 里数字用 z.coerce.number: Hono 的 query 全是字符串 需先转数字
 */
import { z } from 'zod'
import { TICKET_STATUSES, TAG_MODES } from './types'

// 工单 id 格式 T + 4 位数字 如 T0001
export const ticketIdSchema = z
  .string()
  .regex(/^T\d{4}$/, 'id must match T0001 format')

// 分页列表查询参数 page pageSize 必为合法正整数 shopId status 可选过滤
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  shopId: z.string().min(1).optional(),
  status: z.enum(TICKET_STATUSES).optional(),
})

// 状态流转请求体 只传目标态 当前态由服务端从存储读出 防客户端伪造
export const transitionBodySchema = z.object({
  to: z.enum(TICKET_STATUSES),
})

// 批量标记请求体 ids 非空 tags 非空 mode 默认 add
export const batchTagBodySchema = z.object({
  ids: z.array(ticketIdSchema).min(1, 'ids must not be empty'),
  tags: z.array(z.string().min(1)).min(1, 'tags must not be empty'),
  mode: z.enum(TAG_MODES).default('add'),
})

// 批量退款请求体 ids 非空 amount 可选 单位分 缺省用工单已有金额否则 0
export const batchRefundBodySchema = z.object({
  ids: z.array(ticketIdSchema).min(1, 'ids must not be empty'),
  amount: z.number().int().min(0).optional(),
})

// 提取 schema 输出的类型 供路由层使用
export type ListQuery = z.infer<typeof listQuerySchema>
export type TransitionBody = z.infer<typeof transitionBodySchema>
export type BatchTagBody = z.infer<typeof batchTagBodySchema>
export type BatchRefundBody = z.infer<typeof batchRefundBodySchema>
