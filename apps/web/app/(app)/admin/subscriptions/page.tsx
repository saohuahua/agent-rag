'use client'

import { useCallback, useEffect, useState } from 'react'
import type { PackageSummary, SubscriptionSummary, UpgradeDiff } from '@agent-rag/shared'
import { get, post } from '../../../../lib/api'
import { EmployeeBadge } from '../../chat/components/EmployeeBadge'

/**
 * 订阅管理页 显示锁定版本 升级先预览 diff 确认后才落库
 * 锁定版本是核心语义 老订阅不随新包版本自动变更
 */
export default function SubscriptionsPage() {
  const [subs, setSubs] = useState<SubscriptionSummary[]>([])
  const [packages, setPackages] = useState<PackageSummary[]>([])
  const [diffFor, setDiffFor] = useState<{ id: number; diff: UpgradeDiff } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [newPackageId, setNewPackageId] = useState(0)

  const load = useCallback(async () => {
    const [s, p] = await Promise.all([
      get<SubscriptionSummary[]>('/subscriptions'),
      get<PackageSummary[]>('/packages'),
    ])
    setSubs(s)
    setPackages(p)
  }, [])

  useEffect(() => {
    load().catch(() => undefined)
  }, [load])

  async function previewUpgrade(id: number) {
    const res = await post<{ diff: UpgradeDiff; applied: boolean }>(`/subscriptions/${id}/upgrade`, { confirm: false })
    setDiffFor({ id, diff: res.diff })
  }

  async function confirmUpgrade() {
    if (!diffFor) return
    setConfirming(true)
    try {
      await post(`/subscriptions/${diffFor.id}/upgrade`, { confirm: true })
      setDiffFor(null)
      await load()
    } finally {
      setConfirming(false)
    }
  }

  async function subscribe() {
    if (!newPackageId) return
    await post('/subscriptions', { packageId: newPackageId })
    await load()
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div className="page">
        <h1 className="page-title">订阅管理</h1>
        <p className="page-desc">订阅锁定包版本 发新版本不影响老订阅 升级需显式确认</p>

        {/* 订阅新包 */}
        <div className="card">
          <div className="card-title">订阅新包</div>
          <div className="row" style={{ gap: 8 }}>
            <select className="select" value={newPackageId} onChange={(e) => setNewPackageId(Number(e.target.value))}>
              <option value={0}>选择包…</option>
              {packages.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button className="btn btn-primary btn-sm" disabled={!newPackageId} onClick={subscribe}>订阅</button>
          </div>
        </div>

        {/* 订阅列表 */}
        {subs.map((s) => (
          <div className="card" key={s.id}>
            <div className="row-between">
              <div>
                <div style={{ fontWeight: 600 }}>{s.packageName}</div>
                <div className="small muted">
                  锁定版本 <span className="mono">v{s.lockedPackageVersion}</span>
                  {s.latestVersion > s.lockedPackageVersion && (
                    <> · 最新 <span className="mono">v{s.latestVersion}</span></>
                  )}
                </div>
              </div>
              {s.latestVersion > s.lockedPackageVersion ? (
                <button className="btn btn-sm btn-primary" onClick={() => previewUpgrade(s.id)}>升级预览</button>
              ) : (
                <span className="badge badge-green">已是最新</span>
              )}
            </div>

            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              {s.employees.map((e) => <EmployeeBadge key={e.id} employee={e} />)}
            </div>

            {/* 升级 diff 预览 */}
            {diffFor?.id === s.id && (
              <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 8, padding: 14, background: 'var(--bg-subtle)' }}>
                <div className="card-title" style={{ marginBottom: 8 }}>
                  升级 diff · v{diffFor.diff.fromVersion} → v{diffFor.diff.toVersion}
                </div>
                {diffFor.diff.added.length === 0 && diffFor.diff.removed.length === 0 && diffFor.diff.changed.length === 0 && (
                  <p className="hint">无差异 仅版本号变化</p>
                )}
                {diffFor.diff.added.map((i) => (
                  <div key={i.templateSlug} className="small" style={{ color: 'var(--green)' }}>+ 新增 {i.templateSlug} v{i.templateVersion}</div>
                ))}
                {diffFor.diff.removed.map((i) => (
                  <div key={i.templateSlug} className="small" style={{ color: 'var(--red)' }}>− 移除 {i.templateSlug} v{i.templateVersion}</div>
                ))}
                {diffFor.diff.changed.map((i) => (
                  <div key={i.templateSlug} className="small" style={{ color: 'var(--amber)' }}>~ 变更 {i.templateSlug} v{i.from} → v{i.to}</div>
                ))}
                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <button className="btn btn-sm btn-primary" disabled={confirming} onClick={confirmUpgrade}>
                    {confirming ? '升级中…' : '确认升级'}
                  </button>
                  <button className="btn btn-sm" onClick={() => setDiffFor(null)}>取消</button>
                </div>
              </div>
            )}
          </div>
        ))}

        {subs.length === 0 && <div className="card"><div className="empty">暂无订阅 从上方选择一个包开始</div></div>}
      </div>
    </div>
  )
}
