'use client'

import { useState } from 'react'
import type { RetrievalHit } from '@agent-rag/shared'
import { post } from '../../../../lib/api'

/** 单条命中卡 展示名次与内容片段 */
function HitCard({ hit, rank }: { hit: RetrievalHit; rank: number | undefined }) {
  const dim = rank === undefined
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 8,
        background: dim ? 'var(--bg-subtle)' : 'var(--bg-elevated)',
        opacity: dim ? 0.55 : 1,
      }}
    >
      <div className="row-between" style={{ marginBottom: 4 }}>
        <span className="badge badge-blue">{rank !== undefined ? `#${rank}` : '未参与'}</span>
        <span className="small muted">{hit.headingPath ?? '—'}{hit.page !== null && hit.page !== undefined ? ` · 第${hit.page}页` : ''}</span>
      </div>
      <div className="small" style={{ color: 'var(--text-2)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {hit.content}
      </div>
    </div>
  )
}

/**
 * 检索测试台 双路结果并排 + RRF 融合序列可视化
 * 向量路语义命中 词法路术语命中 融合只按名次
 */
export function DualRecall() {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<RetrievalHit[]>([])
  const [searched, setSearched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function onSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    setLoading(true)
    setError('')
    try {
      const res = await post<{ hits: RetrievalHit[] }>('/kb/search', { query: q })
      setHits(res.hits)
      setSearched(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '检索失败')
    } finally {
      setLoading(false)
    }
  }

  // 三路各自排序
  const byVector = [...hits].sort((a, b) => (a.vectorRank ?? 999) - (b.vectorRank ?? 999))
  const byLexical = [...hits].sort((a, b) => (a.lexicalRank ?? 999) - (b.lexicalRank ?? 999))
  const byRrf = [...hits].sort((a, b) => b.rrfScore - a.rrfScore)

  return (
    <div>
      <form onSubmit={onSearch} className="row" style={{ gap: 8, marginBottom: 16 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="输入查询 如 过敏能退吗 / 七天无理由"
        />
        <button className="btn btn-primary" disabled={loading || !query.trim()}>检索</button>
      </form>

      {error && <p className="error-text">{error}</p>}

      {searched && !loading && (
        <div>
          <p className="hint" style={{ marginBottom: 12 }}>
            共 {hits.length} 条命中 · RRF 融合 k=60 只用两路名次 分数不可比
          </p>
          <div className="grid-2" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
            <div className="card">
              <div className="card-title">向量路（语义）</div>
              {byVector.map((h) => <HitCard key={h.chunkId} hit={h} rank={h.vectorRank} />)}
            </div>
            <div className="card">
              <div className="card-title">词法路（关键词）</div>
              {byLexical.map((h) => <HitCard key={h.chunkId} hit={h} rank={h.lexicalRank} />)}
            </div>
            <div className="card" style={{ borderColor: 'var(--accent)' }}>
              <div className="card-title">RRF 融合</div>
              {byRrf.map((h, i) => (
                <div key={h.chunkId} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
                  <div className="row-between" style={{ marginBottom: 4 }}>
                    <span className="badge badge-green">融合 #{i + 1}</span>
                    <span className="small mono muted">rrf={h.rrfScore.toFixed(4)}</span>
                  </div>
                  <div className="small muted">向量 #{h.vectorRank ?? '—'} · 词法 #{h.lexicalRank ?? '—'}</div>
                  <div className="small" style={{ color: 'var(--text-2)', marginTop: 4 }}>{h.content.slice(0, 60)}…</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {!searched && (
        <div className="empty">输入查询词 对比向量路与词法路的召回差异 再观察 RRF 如何融合排名</div>
      )}
    </div>
  )
}
