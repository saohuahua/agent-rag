import { describe, expect, it, vi } from 'vitest'
import { RetrievalService } from '../../src/rag/retrieval.service'
import type { ChunkRepository } from '../../src/rag/chunk.repository'
import type { GatewayService } from '../../src/gateway/gateway.service'

/** 造仓库 mock 返回可定制的向量/词法行 */
function createRepo() {
  return {
    vectorSearch: vi.fn(),
    lexicalSearch: vi.fn(),
  } as unknown as ChunkRepository
}

/** 词法行 fixture */
function lexRow(id: number) {
  return { id, docId: 1, content: `词法${id}`, headingPath: null, page: null }
}

/** 向量行 fixture */
function vecRow(id: number) {
  return { id, docId: 1, content: `向量${id}`, headingPath: null, page: null }
}

describe('RetrievalService 双路与降级', () => {
  it('channel=auto 双路命中 融合返回带两路名次', async () => {
    const repo = createRepo()
    repo.vectorSearch.mockResolvedValue([vecRow(10), vecRow(11)])
    repo.lexicalSearch.mockResolvedValue([lexRow(11), lexRow(12)])

    const gateway = {
      embeddingHealthy: vi.fn(() => true),
      embedMany: vi.fn(async () => [[0.1]]),
    } as unknown as GatewayService

    const svc = new RetrievalService(gateway, repo)
    const hits = await svc.hybridSearch({ enterpriseId: 1, query: '退货', channel: 'auto' })

    // chunkId 11 两路都命中 分数最高排第一
    expect(hits[0]!.chunkId).toBe(11)
    expect(hits[0]!.vectorRank).toBe(2)
    expect(hits[0]!.lexicalRank).toBe(1)
    expect(hits.every(h => h.rrfScore > 0)).toBe(true)
  })

  it('向量路 reject 自动降级纯词法 vectorRank 全 undefined', async () => {
    const repo = createRepo()
    repo.lexicalSearch.mockResolvedValue([lexRow(21), lexRow(22)])

    const gateway = {
      embeddingHealthy: vi.fn(() => true),
      embedMany: vi.fn(async () => { throw new Error('ECONNREFUSED') }),
    } as unknown as GatewayService

    const svc = new RetrievalService(gateway, repo)
    const hits = await svc.hybridSearch({ enterpriseId: 1, query: '退货', channel: 'auto' })

    expect(hits.length).toBe(2)
    expect(hits.every(h => h.vectorRank === undefined)).toBe(true)
    expect(hits.every(h => h.lexicalRank !== undefined)).toBe(true)
    // 单路时 rrfScore = 1/(60+名次)
    expect(hits[0]!.rrfScore).toBeCloseTo(1 / 61)
    expect(hits[1]!.rrfScore).toBeCloseTo(1 / 62)
  })

  it('embeddingHealthy=false 时 auto 跳过向量路 只走词法', async () => {
    const repo = createRepo()
    repo.lexicalSearch.mockResolvedValue([lexRow(31)])

    const gateway = {
      embeddingHealthy: vi.fn(() => false),
      embedMany: vi.fn(async () => [[0.1]]),
    } as unknown as GatewayService

    const svc = new RetrievalService(gateway, repo)
    await svc.hybridSearch({ enterpriseId: 1, query: '退货', channel: 'auto' })

    expect(gateway.embedMany).not.toHaveBeenCalled()
    expect(repo.vectorSearch).not.toHaveBeenCalled()
    expect(repo.lexicalSearch).toHaveBeenCalledTimes(1)
  })

  it('channel=vector 只走向量路 词法路不参与', async () => {
    const repo = createRepo()
    repo.vectorSearch.mockResolvedValue([vecRow(41)])

    const gateway = {
      embeddingHealthy: vi.fn(() => true),
      embedMany: vi.fn(async () => [[0.1]]),
    } as unknown as GatewayService

    const svc = new RetrievalService(gateway, repo)
    const hits = await svc.hybridSearch({ enterpriseId: 1, query: '退货', channel: 'vector' })

    expect(repo.lexicalSearch).not.toHaveBeenCalled()
    expect(repo.vectorSearch).toHaveBeenCalledTimes(1)
    expect(hits[0]!.lexicalRank).toBeUndefined()
    expect(hits[0]!.vectorRank).toBe(1)
  })

  it('topK 截断生效', async () => {
    const repo = createRepo()
    repo.lexicalSearch.mockResolvedValue([lexRow(1), lexRow(2), lexRow(3), lexRow(4), lexRow(5)])

    const gateway = {
      embeddingHealthy: vi.fn(() => false),
      embedMany: vi.fn(),
    } as unknown as GatewayService

    const svc = new RetrievalService(gateway, repo)
    const hits = await svc.hybridSearch({ enterpriseId: 1, query: '退货', channel: 'auto', topK: 3 })

    expect(hits.length).toBe(3)
  })
})
