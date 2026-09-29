import { describe, expect, it, vi } from 'vitest'
import { ChunkRepository } from '../../src/rag/chunk.repository'
import type { InsertChunk } from '../../src/rag/chunk.repository'
import type { PrismaService } from '../../src/prisma/prisma.service'

/** Prisma.sql 产物最小形状 测试里读取 sql 与 values */
interface SqlCapture {
  sql: string
  values: unknown[]
}

/**
 * 造 PrismaService mock 捕获 $transaction 回调里的 tx 与每条 SQL
 * $queryRaw 返回固定行 $executeRaw 捕获语句
 */
function createPrisma(rows: unknown[] = []) {
  const executed: SqlCapture[] = []
  const queried: SqlCapture[] = []

  const tx = {
    $executeRaw: vi.fn(async (sql: SqlCapture) => {
      executed.push(sql)
      return rows.length
    }),
    $queryRaw: vi.fn(async (sql: SqlCapture) => {
      queried.push(sql)
      return rows
    }),
  }

  const prisma = {
    // 事务回调 内部 tx 与顶层共享捕获数组
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    // 词法检索直接调用顶层 $queryRaw 这里同样捕获
    $queryRaw: vi.fn(async (sql: SqlCapture) => {
      queried.push(sql)
      return rows
    }),
    $executeRaw: vi.fn(async (sql: SqlCapture) => {
      executed.push(sql)
      return rows.length
    }),
  }

  return { prisma, executed, queried }
}

/** 造一个入库 chunk 描述 */
function insertChunk(seq: number): InsertChunk {
  return {
    seq,
    content: `内容${seq}`,
    page: null,
    headingPath: null,
    tokenCount: 2,
    embedding: [0.1, 0.2],
    tokens: ['内容', String(seq)],
  }
}

describe('ChunkRepository 检索 SQL', () => {
  it('向量检索 事务内 SET LOCAL ef_search 且含租户过滤与距离算子', async () => {
    const { prisma, executed, queried } = createPrisma([{ id: 1, docId: 1, content: 'x', headingPath: null, page: null }])

    const repo = new ChunkRepository(prisma as unknown as PrismaService)
    await repo.vectorSearch(7, [0.1, 0.2], 10)

    // 第一条是 SET LOCAL ef_search
    expect(executed[0]!.sql).toContain('SET LOCAL hnsw.ef_search')
    // 查询 SQL 含租户过滤 与 <=> 距离算子 与 ::vector 参数转换
    expect(queried[0]!.sql).toContain('"enterpriseId" =')
    expect(queried[0]!.sql).toContain('<=>')
    expect(queried[0]!.sql).toContain('::vector')
    // 参数值包含租户 id 7
    expect(queried[0]!.values).toContain(7)
  })

  it('词法检索 含租户过滤与 to_tsquery OR 表达式', async () => {
    const { prisma, queried } = createPrisma([])

    const repo = new ChunkRepository(prisma as unknown as PrismaService)
    await repo.lexicalSearch(9, ['七天', '退货'], 20)

    expect(queried[0]!.sql).toContain('"enterpriseId" =')
    expect(queried[0]!.sql).toContain("to_tsquery('simple',")
    // OR 表达式 '七天 | 退货' 作为参数值传入
    expect(queried[0]!.values).toContain('七天 | 退货')
    expect(queried[0]!.values).toContain(9)
  })
})

describe('ChunkRepository 事务入库', () => {
  it('ingest 单事务 幂等 ON CONFLICT 并更新文档状态与计数', async () => {
    const { prisma, executed } = createPrisma()

    const repo = new ChunkRepository(prisma as unknown as PrismaService)
    await repo.ingest(5, [insertChunk(0), insertChunk(1)])

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)

    const insertSqls = executed.filter(s => s.sql.includes('INSERT INTO knowledge_chunks'))
    const updateSqls = executed.filter(s => s.sql.includes('UPDATE knowledge_docs'))

    expect(insertSqls.length).toBe(2)
    expect(updateSqls.length).toBe(1)

    // 幂等 upsert 语义
    expect(insertSqls[0]!.sql).toContain('ON CONFLICT ("docId", seq) DO UPDATE')
    // 向量 ::vector 转换 与 to_tsvector 分词
    expect(insertSqls[0]!.sql).toContain('::vector')
    expect(insertSqls[0]!.sql).toContain("to_tsvector('simple',")
    // 状态置 INDEXED 计数置 chunk 数
    expect(updateSqls[0]!.sql).toContain('"chunkCount"')
    expect(updateSqls[0]!.values).toContain(2)
  })
})
