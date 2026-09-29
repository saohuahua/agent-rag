import { Injectable } from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { DocStatus } from '../generated/prisma/enums'
import { PrismaService } from '../prisma/prisma.service'
import { toTsquery, toTsvectorInput } from './tokenizer'

/** 入库 chunk 描述 */
export interface InsertChunk {
  /** 块序号 文档内唯一 幂等键之一 */
  seq: number
  content: string
  page: number | null
  headingPath: string | null
  tokenCount: number
  /** 1024 维向量 */
  embedding: number[]
  /** 清洗后的分词 供 to_tsvector */
  tokens: string[]
}

/** 向量路原始行 */
export interface VectorRow {
  id: number
  docId: number
  content: string
  headingPath: string | null
  page: number | null
}

/** 词法路原始行 */
export interface LexicalRow {
  id: number
  docId: number
  content: string
  headingPath: string | null
  page: number | null
}

/** 两路各取条数上限 供 RRF 融合 */
const SEARCH_LIMIT = 50

/**
 * chunk 数据访问收口 所有 chunk 的 raw SQL 都在这里
 * 为什么 chunk 必须 raw SQL 不能走 ORM：embedding 是 vector 类型 tsv 是 tsvector
 * Prisma 无法表达这两列 只能 Unsupported 占位 读写必须原生 SQL
 * 为什么租户过滤 JOIN doc 而非 chunk 冗余列：schema 里 chunk 无 enterpriseId 列
 * 检索必须 JOIN knowledge_docs 用 enterpriseId 过滤 见 20-规格/02 §5
 */
@Injectable()
export class ChunkRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 向量近邻检索 余弦距离升序
   * 为什么 SET LOCAL hnsw.ef_search 在事务内：ef_search 是会话级参数
   * 连接池下直接 SET 会污染其他连接 事务内 SET LOCAL 结束自动回滚
   * @param enterpriseId 租户过滤
   * @param vector 查询向量 1024 维
   * @param limit 返回条数 默认 50
   */
  async vectorSearch(enterpriseId: number, vector: number[], limit = SEARCH_LIMIT): Promise<VectorRow[]> {
    // 向量序列化为 '[0.1,...]' 字符串再 ::vector 转换 参数化防注入
    const vecStr = `[${vector.join(',')}]`

    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL hnsw.ef_search = 100`)
      return tx.$queryRaw<VectorRow[]>(Prisma.sql`
        SELECT c.id, c."docId", c.content, c."headingPath", c.page
        FROM knowledge_chunks c
        JOIN knowledge_docs d ON d.id = c."docId"
        WHERE d."enterpriseId" = ${enterpriseId}
          AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> ${vecStr}::vector
        LIMIT ${limit}
      `)
    })
  }

  /**
   * 词法检索 ts_rank 排序
   * 为什么 ts_rank 而非 BM25：PG 内置函数 且 RRF 只用排名 两路评分差异被屏蔽
   * @param enterpriseId 租户过滤
   * @param tokens 已清洗分词
   * @param limit 返回条数 默认 50
   */
  async lexicalSearch(enterpriseId: number, tokens: string[], limit = SEARCH_LIMIT): Promise<LexicalRow[]> {
    // OR 表达式宽容匹配 见 tokenizer.toTsquery
    const orExpr = toTsquery(tokens)

    return this.prisma.$queryRaw<LexicalRow[]>(Prisma.sql`
      SELECT c.id, c."docId", c.content, c."headingPath", c.page
      FROM knowledge_chunks c
      JOIN knowledge_docs d ON d.id = c."docId"
      WHERE d."enterpriseId" = ${enterpriseId}
        AND c.tsv @@ to_tsquery('simple', ${orExpr})
      ORDER BY ts_rank(c.tsv, to_tsquery('simple', ${orExpr})) DESC
      LIMIT ${limit}
    `)
  }

  /**
   * 单事务写入 chunk 并更新文档状态 全成或全滚
   * 为什么幂等用 ON CONFLICT DO UPDATE：unique(docId,seq) 保证重跑不产生重复行
   * 为什么逐行 INSERT 而非 COPY 批量：万级 chunk 以下逐行足够 清晰优先
   * @param docId 文档 id
   * @param chunks 入库 chunk 列表 顺序即 seq 已排好
   */
  async ingest(docId: number, chunks: InsertChunk[]): Promise<void> {
    await this.prisma.$transaction(async tx => {
      for (const c of chunks) {
        // 向量字符串化 ::vector 转换 tsv 用 to_tsvector('simple', tokens空格串)
        const vecStr = `[${c.embedding.join(',')}]`
        const tsvInput = toTsvectorInput(c.tokens)

        await tx.$executeRaw(Prisma.sql`
          INSERT INTO knowledge_chunks ("docId", seq, content, page, "headingPath", "tokenCount", embedding, tsv)
          VALUES (${docId}, ${c.seq}, ${c.content}, ${c.page}, ${c.headingPath}, ${c.tokenCount}, ${vecStr}::vector, to_tsvector('simple', ${tsvInput}))
          ON CONFLICT ("docId", seq) DO UPDATE SET
            content = EXCLUDED.content,
            page = EXCLUDED.page,
            "headingPath" = EXCLUDED."headingPath",
            "tokenCount" = EXCLUDED."tokenCount",
            embedding = EXCLUDED.embedding,
            tsv = EXCLUDED.tsv
        `)
      }

      // 文档状态与计数随 chunk 同一事务落库 保证前端轮询到的 INDEXED 一定带着完整 chunk
      await tx.$executeRaw(Prisma.sql`
        UPDATE knowledge_docs SET status = ${DocStatus.INDEXED}, "chunkCount" = ${chunks.length} WHERE id = ${docId}
      `)
    })
  }
}
