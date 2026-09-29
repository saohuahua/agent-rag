'use client'

import { useCallback, useEffect, useState } from 'react'
import type { DepartmentNode, EmployeeSummary, GrantSummary, MemberSummary } from '@agent-rag/shared'
import { get, post, del } from '../../../../lib/api'

/** 部门树递归节点 物化路径已组装成树 */
function DeptNode({ node, depth }: { node: DepartmentNode; depth: number }) {
  return (
    <div>
      <div style={{ padding: '4px 8px', paddingLeft: 8 + depth * 20, borderRadius: 6, background: depth === 0 ? 'var(--bg-subtle)' : undefined, fontWeight: depth === 0 ? 600 : 400 }}>
        {node.name}
        <span className="small mono muted" style={{ marginLeft: 8 }}>{node.path}</span>
      </div>
      {node.children.map((c) => <DeptNode key={c.id} node={c} depth={depth + 1} />)}
    </div>
  )
}

/** 角色徽标 */
const ROLE: Record<string, { label: string; cls: string }> = {
  OWNER: { label: '所有者', cls: 'badge-purple' },
  ADMIN: { label: '管理员', cls: 'badge-blue' },
  MEMBER: { label: '成员', cls: 'badge-gray' },
}

/**
 * 部门与授权页 部门树 + 成员列表 + 员工授权三 scope
 * 授权解析时按 企业→部门子树→成员 三层收窄
 */
export default function OrgPage() {
  const [depts, setDepts] = useState<DepartmentNode[]>([])
  const [members, setMembers] = useState<MemberSummary[]>([])
  const [grants, setGrants] = useState<GrantSummary[]>([])
  const [employees, setEmployees] = useState<EmployeeSummary[]>([])

  // 授权表单
  const [empId, setEmpId] = useState(0)
  const [scopeType, setScopeType] = useState<'ENTERPRISE' | 'DEPARTMENT' | 'MEMBER'>('ENTERPRISE')
  const [scopeId, setScopeId] = useState<number | null>(null)
  const [granting, setGranting] = useState(false)

  const load = useCallback(async () => {
    const [d, m, g, e] = await Promise.all([
      get<DepartmentNode[]>('/departments/tree'),
      get<MemberSummary[]>('/members'),
      get<GrantSummary[]>('/grants'),
      get<EmployeeSummary[]>('/employees'),
    ])
    setDepts(d)
    setMembers(m)
    setGrants(g)
    setEmployees(e)
  }, [])

  useEffect(() => {
    load().catch(() => undefined)
  }, [load])

  async function addGrant(e: React.FormEvent) {
    e.preventDefault()
    if (!empId) return
    setGranting(true)
    try {
      await post('/grants', { employeeId: empId, scopeType, scopeId: scopeType === 'ENTERPRISE' ? null : scopeId })
      await load()
    } finally {
      setGranting(false)
    }
  }

  async function revoke(id: number) {
    await del(`/grants/${id}`)
    await load()
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div className="page">
        <h1 className="page-title">部门与授权</h1>
        <p className="page-desc">部门树物化路径 · 成员 RBAC · 员工授权企业/部门/成员三层</p>

        <div style={{ display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          {/* 部门树 */}
          <div className="card">
            <div className="card-title">部门树</div>
            {depts.map((n) => <DeptNode key={n.id} node={n} depth={0} />)}
          </div>

          {/* 成员 */}
          <div className="card">
            <div className="card-title">成员列表</div>
            <table className="table">
              <thead>
                <tr><th>姓名</th><th>邮箱</th><th>角色</th><th>部门</th></tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const role = ROLE[m.role] ?? { label: m.role, cls: 'badge-gray' }
                  return (
                    <tr key={m.id}>
                      <td>{m.displayName}</td>
                      <td className="muted">{m.email}</td>
                      <td><span className={`badge ${role.cls}`}>{role.label}</span></td>
                      <td className="small muted">{m.departmentId ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* 员工授权 */}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title">员工授权</div>

          <form onSubmit={addGrant} className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <select className="select" value={empId} onChange={(e) => setEmpId(Number(e.target.value))}>
              <option value={0}>选择员工…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.displayName}</option>)}
            </select>
            <select className="select" value={scopeType} onChange={(e) => setScopeType(e.target.value as 'ENTERPRISE' | 'DEPARTMENT' | 'MEMBER')}>
              <option value="ENTERPRISE">企业级</option>
              <option value="DEPARTMENT">部门级</option>
              <option value="MEMBER">成员级</option>
            </select>
            {scopeType !== 'ENTERPRISE' && (
              <input
                className="input"
                type="number"
                placeholder={scopeType === 'DEPARTMENT' ? '部门 id' : '成员 id'}
                value={scopeId ?? ''}
                onChange={(e) => setScopeId(Number(e.target.value) || null)}
              />
            )}
            <button className="btn btn-sm btn-primary" disabled={granting || !empId} type="submit">新增授权</button>
          </form>

          <table className="table">
            <thead>
              <tr><th>员工</th><th>范围</th><th>范围 id</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.id}>
                  <td>{g.employeeName}</td>
                  <td><span className="badge badge-blue">{g.scopeType}</span></td>
                  <td className="mono muted">{g.scopeId ?? '—'}</td>
                  <td><span className="badge badge-green">{g.status}</span></td>
                  <td><button className="btn btn-sm btn-danger" onClick={() => revoke(g.id)}>撤销</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
