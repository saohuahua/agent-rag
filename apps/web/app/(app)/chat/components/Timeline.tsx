'use client'

import { useEffect, useRef, useState } from 'react'
import type { ExecutionEventItem, EmployeeSummary } from '@agent-rag/shared'
import { eventsUrl } from '../../../../lib/api'

/** 事件类型中文标签与配色 未知类型灰色兜底 */
const EVENT_META: Record<string, { label: string; color: string }> = {
  TURN_START: { label: '开始处理', color: 'var(--accent)' },
  SKILL_START: { label: '调用技能', color: 'var(--purple)' },
  SKILL_END: { label: '技能完成', color: 'var(--purple)' },
  TAKEOVER: { label: '转接', color: 'var(--amber)' },
  TURN_END: { label: '处理完成', color: 'var(--green)' },
  LOCK_WAIT: { label: '排队等待', color: 'var(--text-3)' },
}

/** 事件载荷摘要 中文可读 */
function summarize(ev: ExecutionEventItem, employees: EmployeeSummary[]): string {
  const name = (id: number | null) => (id === null ? '系统' : employees.find((e) => e.id === id)?.displayName ?? `员工${id}`)
  const p = ev.payload as Record<string, unknown> | null

  switch (ev.type) {
    case 'SKILL_START':
      return `调用技能 ${String(p?.skill ?? '')}`
    case 'SKILL_END': {
      const hits = p?.hits
      return `技能 ${String(p?.skill ?? '')} 完成${hits !== undefined ? ` 命中 ${String(hits)} 条` : ''}`
    }
    case 'TAKEOVER':
      return `${name(p?.fromEmployeeId as number | null)} → ${name(p?.toEmployeeId as number | null)}`
    case 'TURN_START':
      return `第 ${String(p?.epoch ?? '?')} 轮`
    case 'TURN_END':
      return `第 ${String(p?.epoch ?? '?')} 轮完成`
    default:
      return ''
  }
}

/**
 * 执行时间线 独立 EventSource 订阅事件 SSE
 * 与 useChat 流解耦 靠事件 id 去重 支持断线重连后的历史重放
 * @param sessionId 会话 id
 * @param employees 员工字典 名称解析用
 * @param onHolderChange TAKEOVER 事件后通知上层切换徽标
 */
export function Timeline({
  sessionId,
  employees,
  onHolderChange,
}: {
  sessionId: number
  employees: EmployeeSummary[]
  onHolderChange?: (employeeId: number) => void
}) {
  const [events, setEvents] = useState<ExecutionEventItem[]>([])
  const lastIdRef = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setEvents([])
    lastIdRef.current = 0

    // withCredentials 跨域真实后端时携带 JWT cookie
    const es = new EventSource(eventsUrl(sessionId), { withCredentials: true })

    es.onmessage = (ev) => {
      let data: ExecutionEventItem
      try {
        data = JSON.parse(ev.data) as ExecutionEventItem
      } catch {
        return
      }
      // 断线重连服务端会重放历史 按 id 去重
      if (data.id <= lastIdRef.current) return
      lastIdRef.current = data.id
      setEvents((prev) => [...prev, data])

      // 转接事件 通知上层切换当前员工徽标
      if (data.type === 'TAKEOVER' && onHolderChange) {
        const to = (data.payload as { toEmployeeId?: number } | null)?.toEmployeeId
        if (typeof to === 'number') onHolderChange(to)
      }
    }

    return () => es.close()
  }, [sessionId, onHolderChange])

  // 新事件滚到底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
        <span className="card-title" style={{ margin: 0 }}>执行时间线</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
        {events.length === 0 && <div className="empty small">发送消息后这里实时展示工具调用与转接</div>}
        {events.map((ev) => {
          const meta = EVENT_META[ev.type] ?? { label: ev.type, color: 'var(--text-3)' }
          const name = ev.employeeId === null ? '系统' : employees.find((e) => e.id === ev.employeeId)?.displayName ?? `员工${ev.employeeId}`
          const time = new Date(ev.createdAt).toLocaleTimeString('zh-CN', { hour12: false })
          return (
            <div key={ev.id} style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
              <span
                style={{
                  flex: '0 0 auto',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  marginTop: 6,
                  background: meta.color,
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="badge" style={{ background: meta.color, color: '#fff', padding: '1px 8px' }}>
                    {meta.label}
                  </span>
                  <span className="small muted">{name}</span>
                  <span className="small muted mono">{time}</span>
                </div>
                {summarize(ev, employees) && <div className="small" style={{ color: 'var(--text-2)' }}>{summarize(ev, employees)}</div>}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
