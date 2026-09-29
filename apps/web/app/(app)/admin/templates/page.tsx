'use client'

import { useCallback, useEffect, useState } from 'react'
import type { DatasetSummary, SkillSummary, TemplateSummary } from '@agent-rag/shared'
import { get, post } from '../../../../lib/api'

/** 状态徽标映射 */
const STATUS: Record<TemplateSummary['status'], { label: string; cls: string }> = {
  DRAFT: { label: '草稿', cls: 'badge-gray' },
  PENDING_REVIEW: { label: '待审核', cls: 'badge-amber' },
  PUBLISHED: { label: '已发布', cls: 'badge-green' },
  ARCHIVED: { label: '已归档', cls: 'badge-gray' },
  REJECTED: { label: '已驳回', cls: 'badge-red' },
}

/**
 * 模板管理页 起草 + 审核发布
 * systemPrompt 编辑器 + 技能/KB 绑定 + 状态机流转
 */
export default function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])

  // 起草表单
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [pickedSkills, setPickedSkills] = useState<string[]>([])
  const [pickedDss, setPickedDss] = useState<number[]>([])
  const [drafting, setDrafting] = useState(false)

  const load = useCallback(async () => {
    const [t, s, d] = await Promise.all([
      get<TemplateSummary[]>('/templates'),
      get<SkillSummary[]>('/skills'),
      get<DatasetSummary[]>('/kb/datasets'),
    ])
    setTemplates(t)
    setSkills(s)
    setDatasets(d)
  }, [])

  useEffect(() => {
    load().catch(() => undefined)
  }, [load])

  function toggleSkill(key: string) {
    setPickedSkills((prev) => (prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]))
  }

  function toggleDs(id: number) {
    setPickedDss((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function draft(e: React.FormEvent) {
    e.preventDefault()
    if (!slug.trim() || !name.trim() || !systemPrompt.trim()) return
    setDrafting(true)
    try {
      await post<TemplateSummary>('/templates', {
        slug: slug.trim(),
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        skillBindings: pickedSkills.map((skillKey) => ({ skillKey, configJson: {} })),
        kbBindings: pickedDss.map((datasetId) => ({ datasetId, kbMode: 'BOTH' })),
      })
      setSlug('')
      setName('')
      setDescription('')
      setSystemPrompt('')
      setPickedSkills([])
      setPickedDss([])
      await load()
    } finally {
      setDrafting(false)
    }
  }

  async function act(id: number, action: 'submit' | 'publish' | 'reject') {
    if (action === 'reject') {
      const note = window.prompt('驳回原因（中文）') ?? ''
      await post(`/templates/${id}/reject`, { reviewNote: note })
    } else {
      await post(`/templates/${id}/${action}`)
    }
    await load()
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div className="page">
        <h1 className="page-title">模板管理</h1>
        <p className="page-desc">岗位模板 起草 → 审核 → 发布 发布后不可改 新行为走新版本</p>

        {/* 起草表单 */}
        <form className="card" onSubmit={draft}>
          <div className="card-title">起草模板</div>
          <div className="grid-2">
            <div className="field">
              <label>slug（唯一标识）</label>
              <input className="input" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="after-sale" />
            </div>
            <div className="field">
              <label>名称</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="售后侠" />
            </div>
          </div>
          <div className="field">
            <label>描述</label>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话职责" />
          </div>
          <div className="field">
            <label>systemPrompt（设计意图 禁改提示见注释）</label>
            <textarea className="textarea" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="你是售后侠 一名电商售后客服…" />
          </div>

          <div className="grid-2">
            <div className="field">
              <label>绑定技能</label>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {skills.map((s) => (
                  <button key={s.key} type="button" onClick={() => toggleSkill(s.key)} className="btn btn-sm"
                    style={{ background: pickedSkills.includes(s.key) ? 'var(--accent-soft)' : undefined, color: pickedSkills.includes(s.key) ? 'var(--accent)' : undefined }}>
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>绑定知识库</label>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {datasets.map((d) => (
                  <button key={d.id} type="button" onClick={() => toggleDs(d.id)} className="btn btn-sm"
                    style={{ background: pickedDss.includes(d.id) ? 'var(--accent-soft)' : undefined, color: pickedDss.includes(d.id) ? 'var(--accent)' : undefined }}>
                    {d.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button className="btn btn-primary" disabled={drafting} type="submit">保存草稿</button>
        </form>

        {/* 模板列表 */}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title">模板列表</div>
          <table className="table">
            <thead>
              <tr>
                <th>模板</th>
                <th>版本</th>
                <th>状态</th>
                <th>技能 / KB</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => {
                const s = STATUS[t.status]
                return (
                  <tr key={t.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{t.name}</div>
                      <div className="small muted">{t.description}</div>
                      {t.reviewNote && <div className="small" style={{ color: 'var(--red)' }}>驳回：{t.reviewNote}</div>}
                    </td>
                    <td className="mono">v{t.version}</td>
                    <td><span className={`badge ${s.cls}`}>{s.label}</span></td>
                    <td className="small muted">
                      {t.skillBindings.map((b) => b.skillKey).join(' / ') || '—'}
                      <br />
                      KB {t.kbBindings.map((b) => `#${b.datasetId}`).join(' / ') || '—'}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {(t.status === 'DRAFT' || t.status === 'REJECTED') && (
                          <button className="btn btn-sm" onClick={() => act(t.id, 'submit')}>提交审核</button>
                        )}
                        {t.status === 'PENDING_REVIEW' && (
                          <>
                            <button className="btn btn-sm btn-primary" onClick={() => act(t.id, 'publish')}>发布</button>
                            <button className="btn btn-sm btn-danger" onClick={() => act(t.id, 'reject')}>驳回</button>
                          </>
                        )}
                        {t.status === 'PUBLISHED' && <span className="hint">已锁定不可改</span>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
