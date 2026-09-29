'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import type { DatasetSummary, DocSummary } from '@agent-rag/shared'
import { get, post } from '../../../lib/api'
import { Uploader } from './components/Uploader'
import { DocTable } from './components/DocTable'

/**
 * 知识库页 数据集列表 + 文档管理
 * 左侧数据集 右侧文档表格与上传器
 */
export default function KbPage() {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const loadDatasets = useCallback(async () => {
    const list = await get<DatasetSummary[]>('/kb/datasets')
    setDatasets(list)
    return list
  }, [])

  const loadDocs = useCallback(async (id: number) => {
    const list = await get<DocSummary[]>(`/kb/datasets/${id}/docs`)
    setDocs(list)
  }, [])

  useEffect(() => {
    loadDatasets().catch(() => setDatasets([]))
  }, [loadDatasets])

  // 选中数据集时加载文档
  useEffect(() => {
    if (selectedId !== null) loadDocs(selectedId).catch(() => setDocs([]))
  }, [selectedId, loadDocs])

  async function createDataset(e: React.FormEvent) {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      const ds = await post<DatasetSummary>('/kb/datasets', { name })
      setNewName('')
      setDatasets((prev) => [...prev, ds])
      setSelectedId(ds.id)
    } finally {
      setCreating(false)
    }
  }

  const onUploaded = useCallback(() => {
    if (selectedId !== null) loadDocs(selectedId).catch(() => undefined)
  }, [selectedId, loadDocs])

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div className="page">
        <div className="row-between">
          <div>
            <h1 className="page-title">知识库</h1>
            <p className="page-desc">上传规则文档 解析入库 供数字员工检索引用</p>
          </div>
          <Link href="/kb/search" className="btn btn-primary btn-sm">检索测试台</Link>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          {/* 数据集列表 */}
          <div className="card">
            <div className="card-title">数据集</div>
            {datasets.map((d) => (
              <button
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className="btn"
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  background: d.id === selectedId ? 'var(--accent-soft)' : 'transparent',
                  color: d.id === selectedId ? 'var(--accent)' : 'var(--text)',
                  marginBottom: 4,
                }}
              >
                <div style={{ fontWeight: 500 }}>{d.name}</div>
                <div className="small muted">{d.docCount} 篇文档</div>
              </button>
            ))}
            {datasets.length === 0 && <div className="empty small">暂无数据集</div>}

            <form onSubmit={createDataset} style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div className="field">
                <label>新建数据集</label>
                <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="数据集名称" />
              </div>
              <button className="btn btn-sm" disabled={creating || !newName.trim()} type="submit">创建</button>
            </form>
          </div>

          {/* 文档管理 */}
          <div>
            {selectedId !== null ? (
              <>
                <Uploader datasetId={selectedId} onUploaded={onUploaded} />
                <DocTable docs={docs} />
              </>
            ) : (
              <div className="card"><div className="empty">选择一个数据集查看文档</div></div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
