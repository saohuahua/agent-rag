import { z } from 'zod'
import type { SkillDef } from '../skill-executor'

/**
 * compliance_check 合规检查入参
 * 检查商品标题与描述是否含广告法禁词或违禁信息
 */
export const ComplianceCheckSchema = z.object({
  title: z.string().min(1).max(200).describe('商品标题'),
  category: z.string().min(1).max(50).describe('商品类目 如 化妆品 食品'),
  description: z.string().max(2000).optional().describe('商品详情描述 可空'),
})
export type ComplianceCheckInput = z.infer<typeof ComplianceCheckSchema>

/**
 * compliance_check 技能定义
 * 设计意图：确定性词表匹配引擎 不消耗 LLM 正则与词表在进程内完成
 * 为什么不走 LLM：合规判断要求可解释可复现 词表命中必须逐字可追溯 LLM 判断无法给出稳定的规则依据
 * 词表读 corpus/compliance/words.json（F 任务产出）
 */
export const ComplianceCheckDef: SkillDef = {
  key: 'compliance_check',
  type: 'BUILTIN_FUNCTION',
  description:
    '检查商品标题与描述是否含广告法禁用词或违禁信息 返回命中词 规则名 严重度 确定性词表匹配不消耗 LLM',
  inputSchema: ComplianceCheckSchema,
  riskLevel: 1,
}
