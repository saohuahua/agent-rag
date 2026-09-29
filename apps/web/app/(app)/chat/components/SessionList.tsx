'use client'

import { useState } from 'react'
import type { EmployeeSummary, SessionSummary } from '@agent-rag/shared'
import { EmployeeBadge } from './EmployeeBadge'

/**
 * 会话列表 新建时弹窗选员工阵容
 * @param sessions 会话列表
 * @param selectedId 当前选中
 * @param onSelect 选中回调
 * @param employees 可选员工
 * @param onCreate 新建回调 参数含 title 与 participantEmployeeIds
 */
export function SessionList({
  sessions,
  selectedId,
  onSelect,
  employees,
  onCreate,
}: {
  sessions: SessionSummary[]
  selectedId: number | null
  onSelect: (id: number) => void
  employees: EmployeeSummary[]
  onCreate: (payload: { title: string; participantEmployeeIds: number[] }) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<number[]>([])
  const [busy, setBusy] = useState(false)

  function togglePick(id: number) {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function submit() {
    if (picked.length === 0) return
    setBusy(true)
    try {
      await onCreate({ title, participantEmployeeIds: picked })
      setOpen(false)
      setTitle('')
      setPicked([])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', borderRight: '1px solid var(--border)' }}>
      <div className="row-between" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
        <span className="card-title" style={{ margin: 0 }}>会话</span>
        <button className="btn btn-sm btn-primary" onClick={() => setOpen(true)}>新建</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {sessions.length === 0 && <div className="empty small">还没有会话 点新建开始</div>}
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 'none',
              borderRadius: 8,
              padding: '10px 12px',
              marginBottom: 4,
              background: s.id === selectedId ? 'var(--accent-soft)' : 'transparent',
              color: 'var(--text)',
            }}
          >
            <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.title ?? '未命名会话'}
            </div>
            <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
              {s.participants.map((p) => (
                <EmployeeBadge key={p.id} employee={p} dim={p.id !== s.currentParticipantId} />
              ))}
            </div>
          </button>
        ))}
      </div>

      {/* 新建阵容弹窗 */}
      {open && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(20,30,60,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
          onClick={() => setOpen(false)}
        >
          <div className="card" style={{ width: 440, maxWidth: '92vw' }} onClick={(e) => e.stopPropagation()}>
            <div className="card-title">新建会话 · 选员工阵容</div>

            <div className="field">
              <label>会话标题（可选）</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如 售后咨询" />
            </div>

            <div className="field">
              <label>选择参与员工（按顺序接管）</label>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {employees.map((e) => {
                  const active = picked.includes(e.id)
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => togglePick(e.id)}
                      className="btn btn-sm"
                      style={{
                        borderColor: active ? 'var(--accent)' : 'var(--border-strong)',
                        background: active ? 'var(--accent-soft)' : 'var(--bg-elevated)',
                        color: active ? 'var(--accent)' : 'var(--text)',
                      }}
                    >
                      {e.displayName}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button className="btn" onClick={() => setOpen(false)}>取消</button>
              <button className="btn btn-primary" disabled={picked.length === 0 || busy} onClick={submit}>
                {busy ? '创建中…' : `创建（已选 ${picked.length}）`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
