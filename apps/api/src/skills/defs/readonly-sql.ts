import { z } from 'zod'
import type { SkillDef } from '../skill-executor'

/**
 * run_readonly_sql 只读 SQL 入参
 * question 记录业务问题便于审计 sql 是本技能真正的入参 上限 2000 防超长语句
 */
export const RunReadonlySqlSchema = z.object({
  question: z.string().min(1).max(500).describe('用自然语言描述查询意图 用于审计与展示'),
  sql: z.string().min(1).max(2000).describe('要执行的 SELECT 语句'),
})
export type RunReadonlySqlInput = z.infer<typeof RunReadonlySqlSchema>

/**
 * run_readonly_sql 技能定义
 * 设计意图：允许数字员工对企业数据库做只读查询 但套四道安全边界
 * 1 会话级只读事务 2 单条 SELECT 正则校验 3 表白名单 orders products refunds 4 强制 LIMIT 50
 * 为什么 riskLevel=2：虽只读但执行 raw SQL 属敏感操作 需在审计中留痕
 */
export const RunReadonlySqlDef: SkillDef = {
  key: 'run_readonly_sql',
  type: 'BUILTIN_FUNCTION',
  description:
    '对企业数据库执行只读 SQL 查询 仅允许 orders products refunds 三张表白名单 强制单条 SELECT 并自动加 LIMIT',
  inputSchema: RunReadonlySqlSchema,
  riskLevel: 2,
}
