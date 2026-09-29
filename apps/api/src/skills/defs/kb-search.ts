import { z } from 'zod'
import type { SkillDef } from '../skill-executor'

/**
 * kb_search 知识库检索入参
 * topK 上限 20 防止一次性塞入过多 token 检索范围由 configJson.datasetId 限定
 */
export const KbSearchSchema = z.object({
  query: z.string().min(1).max(500).describe('检索问句 自然语言问题'),
  topK: z.number().int().min(1).max(20).optional().describe('返回片段数 默认 8'),
})
export type KbSearchInput = z.infer<typeof KbSearchSchema>

/**
 * kb_search 技能定义
 * 设计意图：数字员工回答平台规则或售后政策类问题时 先检索企业知识库 命中片段作为上下文再作答
 * 直调 RetrievalService 契约 不经过 LLM 摘要 保证命中内容原始可信
 */
export const KbSearchDef: SkillDef = {
  key: 'kb_search',
  type: 'BUILTIN_FUNCTION',
  description:
    '检索企业知识库 输入自然语言问题 返回相关文档片段摘要 用于回答平台规则或售后政策类问题',
  inputSchema: KbSearchSchema,
  riskLevel: 1,
}
