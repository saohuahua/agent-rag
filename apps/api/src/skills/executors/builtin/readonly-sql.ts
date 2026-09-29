import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../../prisma/prisma.service'
import { SkillInputError } from '../../errors'
import type { SkillCtx, SkillResult } from '../../skill-executor'
import type { RunReadonlySqlInput } from '../../defs/readonly-sql'

/** 只读 SQL 表白名单 三张种子表 其它表一律拒绝 */
const TABLE_WHITELIST: readonly string[] = ['orders', 'products', 'refunds']

/** 结果行数上限 与强制 LIMIT 一致 */
const MAX_ROWS = 50

/**
 * 禁用关键词 命中即拒 大小写不敏感
 * 为什么单列一层：即使单语句校验通过 也要防 SELECT INTO 这类隐藏写操作
 * 词边界 \b 避免误伤 updated_at 这类列名
 */
const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'MERGE',
  'CALL',
  'COPY',
  'VACUUM',
  'INTO',
] as const

/** 单条 SQL 校验结果 */
export interface SqlValidation {
  sql: string
  tableNames: string[]
}

/**
 * 只读 SQL 第一道防线：静态校验
 * 四重检查：单条 SELECT 无分号多语句 无注释 无 DML 关键词 表名全在白名单
 * 为什么注释也禁：-- 与 块注释可隐藏第二段语句 属注入面
 * @param raw 用户或 LLM 生成的 SQL
 */
export function validateReadonlySql(raw: string): SqlValidation {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new SkillInputError('sql is empty')
  }

  // 剥掉结尾单个分号 再查残留分号 任何残留都视为多语句拒绝
  const noTrailing = trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed
  if (noTrailing.includes(';')) {
    throw new SkillInputError('multiple statements rejected')
  }

  // 注释检测
  if (noTrailing.includes('--') || noTrailing.includes('/*') || noTrailing.includes('*/')) {
    throw new SkillInputError('sql comments rejected')
  }

  const upper = noTrailing.toUpperCase()

  // 必须单条 SELECT 开头
  if (!/^SELECT\b/.test(upper)) {
    throw new SkillInputError('only single SELECT statement allowed')
  }

  // DML/DDL 关键词防御
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      throw new SkillInputError(`forbidden keyword ${kw}`)
    }
  }

  // 表名提取 FROM 与 JOIN 子句
  const tableNames: string[] = []
  const tableRe = /(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi
  let m: RegExpExecArray | null
  while ((m = tableRe.exec(noTrailing)) !== null) {
    const t = m[1]
    if (t) tableNames.push(t.toLowerCase())
  }

  if (tableNames.length === 0) {
    throw new SkillInputError('no table found in sql')
  }

  // 白名单校验
  for (const t of tableNames) {
    if (!TABLE_WHITELIST.includes(t)) {
      throw new SkillInputError(`table ${t} not in whitelist`)
    }
  }

  return { sql: noTrailing, tableNames }
}

/**
 * LIMIT 强制注入 无 LIMIT 时包一层子查询强制 50 行 防全表扫描爆内存
 * 为什么用包子查询而非直接追加 LIMIT：原 SQL 可能带 ORDER BY 或聚合 直接追加可能语法错 子查询最稳妥
 * @param sql 已通过静态校验的单条 SELECT
 */
export function ensureLimit(sql: string): string {
  if (/\bLIMIT\b/i.test(sql)) return sql
  return `SELECT * FROM (${sql}) t LIMIT ${MAX_ROWS}`
}

/**
 * run_readonly_sql 执行器 安全边界见 defs/readonly-sql.ts 头注释
 * 两道防线：静态校验（白名单 单语句） + 事务内 SET LOCAL 强制只读
 */
@Injectable()
export class ReadonlySqlExecutor {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 执行只读查询
   * @param input 已过 zod 校验的入参
   */
  async run(input: RunReadonlySqlInput, _ctx: SkillCtx): Promise<SkillResult> {
    // 第一道防线 不满足直接拒 这是安全边界的主证据
    const { sql, tableNames } = validateReadonlySql(input.sql)
    const finalSql = ensureLimit(sql)

    const rows = await this.execReadonly(finalSql)

    return {
      output: {
        question: input.question,
        tableNames,
        rows: rows.slice(0, MAX_ROWS),
        rowCount: rows.length,
      },
      summary: `查询返回 ${rows.length} 行`,
    }
  }

  /**
   * 第二道防线：事务内强制只读 任何写操作会被 Postgres 拒绝
   * 为什么用 transaction_read_only 而非 default_transaction_read_only：后者是会话级默认值
   * Prisma 连接池复用会话 会话级设置会残留只读态污染其它请求 事务级 SET LOCAL 只影响当前事务
   */
  private async execReadonly(sql: string): Promise<Record<string, unknown>[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL transaction_read_only = on')
      return tx.$queryRawUnsafe<Record<string, unknown>[]>(sql)
    })
  }
}
