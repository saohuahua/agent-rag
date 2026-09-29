import { describe, expect, it } from 'vitest'
import { rrfFuse } from '../../src/rag/retrieval.service'
import type { RankedHit } from '../../src/rag/retrieval.service'

/** 造一个命中项 */
function hit(chunkId: number): RankedHit {
  return { chunkId, docId: 1, content: `c${chunkId}`, headingPath: null, page: null }
}

describe('RRF 纯函数融合', () => {
  it('两路排名融合 分数与 k=60 手算一致 序正确', () => {
    // 向量路 [a(1) b(2)] 词法路 [c(1) a(2)] a 出现在两路
    const vecHits = [hit(1), hit(2)]
    const lexHits = [hit(3), hit(1)]

    const fused = rrfFuse(vecHits, lexHits)

    const r61 = 1 / 61
    const r62 = 1 / 62

    // a=1/61+1/62 c=1/61 b=1/62 序 a > c > b
    expect(fused.map(f => f.chunkId)).toEqual([1, 3, 2])

    const byId = new Map(fused.map(f => [f.chunkId, f]))
    expect(byId.get(1)!.rrfScore).toBeCloseTo(r61 + r62)
    expect(byId.get(1)!.vectorRank).toBe(1)
    expect(byId.get(1)!.lexicalRank).toBe(2)
    expect(byId.get(3)!.rrfScore).toBeCloseTo(r61)
    expect(byId.get(3)!.lexicalRank).toBe(1)
    expect(byId.get(3)!.vectorRank).toBeUndefined()
    expect(byId.get(2)!.rrfScore).toBeCloseTo(r62)
    expect(byId.get(2)!.vectorRank).toBe(2)
  })

  it('单路时退化为该路名次折算分', () => {
    const fused = rrfFuse([hit(1), hit(2)], [])

    expect(fused.length).toBe(2)
    expect(fused[0]!.rrfScore).toBeCloseTo(1 / 61)
    expect(fused[1]!.rrfScore).toBeCloseTo(1 / 62)
    expect(fused[0]!.vectorRank).toBe(1)
    expect(fused[1]!.lexicalRank).toBeUndefined()
  })

  it('空路融合返回空', () => {
    expect(rrfFuse([], [])).toEqual([])
  })
})
