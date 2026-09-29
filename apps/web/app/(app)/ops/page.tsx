'use client'

import { useEffect, useMemo, useState } from 'react'
import type { UsageGroup } from '@agent-rag/shared'
import { get } from '../../../lib/api'

/** 别名中文名映射 */
const ALIAS: Record<string, string> = {
  chat: '普通对话',
  'strong-chat': '强模型',
  embedding: '向量化',
}

/**
 * 成本报表页 usage 汇总表格 + CSS 手绘条形图
 * 无图表库 条形宽度按成本比例 遵守依赖纪律
 */
export default function OpsPage() {
  const [groups, setGroups] = useState<UsageGroup[]>([])

  useEffect(() => {
    get<{ groups: UsageGroup[] }>('/admin/usage/summary')
      .then((r) => setGroups(r.groups))
      .catch(() => setGroups([]))
  }, [])

  // 按别名聚合成本 供条形图
  const byAlias = useMemo(() => {
    const acc = new Map<string, number>()
    for (const g of groups) {
      acc.set(g.routeAlias, (acc.get(g.routeAlias) ?? 0) + Number(g.costCny))
    }
    const list = [...acc.entries()].map(([alias, cost]) => ({ alias, cost })).sort((a, b) => b.cost - a.cost)
    const max = Math.max(...list.map((x) => x.cost), 0.0001)
    return { list, max }
  }, [groups])

  const totalCost = useMemo(() => groups.reduce((s, g) => s + Number(g.costCny), 0), [groups])

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div className="page">
        <h1 className="page-title">成本报表</h1>
        <p className="page-desc">算力账本 一切成本数字唯一来源 usage_records</p>

        {/* 条形图 成本按别名 */}
        <div className="card">
          <div className="card-title">成本分布（按别名）</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {byAlias.list.map(({ alias, cost }) => (
              <div key={alias} className="row" style={{ gap: 12 }}>
                <span className="small" style={{ width: 70, flex: '0 0 auto' }}>{ALIAS[alias] ?? alias}</span>
                <div style={{ flex: 1, height: 22, background: 'var(--bg-subtle)', borderRadius: 6, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${(cost / byAlias.max) * 100}%`,
                      background: alias === 'embedding' ? 'var(--purple)' : 'var(--accent)',
                      borderRadius: 6,
                    }}
                  />
                </div>
                <span className="mono small" style={{ width: 80, flex: '0 0 auto', textAlign: 'right' }}>¥{cost.toFixed(2)}</span>
              </div>
            ))}
            {byAlias.list.length === 0 && <div className="empty small">暂无用量数据</div>}
          </div>
          <div className="row-between" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <span className="muted">合计成本</span>
            <span className="mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>¥{totalCost.toFixed(2)}</span>
          </div>
        </div>

        {/* 汇总表格 */}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title">usage 汇总</div>
          <table className="table">
            <thead>
              <tr>
                <th>日期</th>
                <th>别名</th>
                <th>调用次数</th>
                <th>输入 tokens</th>
                <th>输出 tokens</th>
                <th>成本（元）</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g, i) => (
                <tr key={`${g.day}-${g.routeAlias}-${i}`}>
                  <td className="mono">{g.day}</td>
                  <td>{ALIAS[g.routeAlias] ?? g.routeAlias}</td>
                  <td className="mono">{g.calls}</td>
                  <td className="mono">{g.inputTokens}</td>
                  <td className="mono">{g.outputTokens}</td>
                  <td className="mono" style={{ color: 'var(--accent)' }}>¥{Number(g.costCny).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
