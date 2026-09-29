import { z } from 'zod'
import type { SkillDef } from '../skill-executor'

/**
 * batch_scan 批量合规扫描入参
 * productIds 上限 200 防止单次 RPA 调用塞入过多商品导致外部系统超时
 */
export const BatchScanSchema = z.object({
  productIds: z.array(z.string().min(1)).min(1).max(200).describe('待扫描的商品 id 列表'),
})
export type BatchScanInput = z.infer<typeof BatchScanSchema>

/**
 * batch_scan 技能定义
 * 设计意图：批量商品合规风险扫描 走外部工单系统 /scan 端点 返回每个商品的合规风险等级
 * 为什么是 HTTP_RPA：扫描逻辑在外部系统 本服务只负责调用与重试 不在进程内实现
 */
export const BatchScanDef: SkillDef = {
  key: 'batch_scan',
  type: 'HTTP_RPA',
  description: '批量扫描商品合规风险 调外部系统返回每个商品的风险等级 用于上架前合规自查',
  inputSchema: BatchScanSchema,
  riskLevel: 1,
}
