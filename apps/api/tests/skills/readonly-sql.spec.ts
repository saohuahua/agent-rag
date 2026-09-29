import { describe, expect, it, vi } from 'vitest'
import {
  ensureLimit,
  ReadonlySqlExecutor,
  validateReadonlySql,
} from '../../src/skills/executors/builtin/readonly-sql'
import { SkillInputError } from '../../src/skills/errors'
import type { PrismaService } from '../../src/prisma/prisma.service'
import type { SkillCtx } from '../../src/skills/skill-executor'

function makeCtx(): SkillCtx {
  return {
    sessionId: 1,
    employeeId: 2,
    templateSlug: 'analyst',
    configJson: null,
    ctx: { enterpriseId: 1, memberId: 1, role: 'OWNER' },
    emit: async () => undefined,
  }
}

describe('validateReadonlySql 安全边界', () => {
  it('白名单表 SELECT 通过并提取表名', () => {
    const v = validateReadonlySql('SELECT * FROM orders')
    expect(v.tableNames).toEqual(['orders'])
  })

  it('DROP 语句拒绝', () => {
    expect(() => validateReadonlySql('DROP TABLE orders')).toThrow(SkillInputError)
  })

  it('DELETE 语句拒绝', () => {
    expect(() => validateReadonlySql('DELETE FROM orders WHERE id = 1')).toThrow(SkillInputError)
  })

  it('多语句分号拒绝', () => {
    expect(() => validateReadonlySql('SELECT * FROM orders; DROP TABLE orders')).toThrow(SkillInputError)
  })

  it('SELECT INTO 隐藏写操作拒绝', () => {
    expect(() => validateReadonlySql('SELECT * INTO new_table FROM orders')).toThrow(SkillInputError)
  })

  it('注释拒绝', () => {
    expect(() => validateReadonlySql('SELECT * FROM orders -- 注释')).toThrow(SkillInputError)
    expect(() => validateReadonlySql('SELECT * /* 注释 */ FROM orders')).toThrow(SkillInputError)
  })

  it('非 SELECT 开头拒绝', () => {
    expect(() => validateReadonlySql('SHOW TABLES')).toThrow(SkillInputError)
  })

  it('白名单外表拒绝 users 不在白名单', () => {
    expect(() => validateReadonlySql('SELECT * FROM users')).toThrow(SkillInputError)
  })

  it('JOIN 白名单外表拒绝', () => {
    expect(() => validateReadonlySql('SELECT * FROM orders JOIN users ON 1=1')).toThrow(SkillInputError)
  })

  it('空 SQL 拒绝', () => {
    expect(() => validateReadonlySql('   ')).toThrow(SkillInputError)
  })
})

describe('ensureLimit LIMIT 强制注入', () => {
  it('无 LIMIT 时包一层子查询强制 50 行', () => {
    const sql = ensureLimit('SELECT * FROM orders')
    expect(sql).toContain('LIMIT 50')
  })

  it('已带 LIMIT 保持原样', () => {
    const sql = ensureLimit('SELECT * FROM orders LIMIT 10')
    expect(sql).toBe('SELECT * FROM orders LIMIT 10')
  })
})

describe('ReadonlySqlExecutor 执行', () => {
  it('校验通过后 强制只读事务并执行查询 返回行数', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }])
    const execRaw = vi.fn().mockResolvedValue(1)
    const tx = { $executeRawUnsafe: execRaw, $queryRawUnsafe: queryRaw }
    const transaction = vi.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx))
    const prisma = { $transaction: transaction } as unknown as PrismaService

    const executor = new ReadonlySqlExecutor(prisma)
    const r = await executor.run({ question: '查订单', sql: 'SELECT * FROM orders' }, makeCtx())

    // 第二道防线 事务内 SET LOCAL 只读
    expect(execRaw).toHaveBeenCalledWith('SET LOCAL transaction_read_only = on')
    // 无 LIMIT 已自动包裹
    expect(queryRaw).toHaveBeenCalledWith(expect.stringContaining('LIMIT 50'))
    const output = r.output as { rows: unknown[]; rowCount: number }
    expect(output.rows).toHaveLength(2)
    expect(output.rowCount).toBe(2)
  })

  it('非法 SQL 在到达数据库前被拒 不触发事务', async () => {
    const transaction = vi.fn()
    const prisma = { $transaction: transaction } as unknown as PrismaService
    const executor = new ReadonlySqlExecutor(prisma)

    await expect(
      executor.run({ question: 'x', sql: 'DROP TABLE orders' }, makeCtx()),
    ).rejects.toBeInstanceOf(SkillInputError)
    expect(transaction).not.toHaveBeenCalled()
  })
})
