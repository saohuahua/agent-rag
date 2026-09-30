'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EmployeeSummary, SessionSummary } from '@agent-rag/shared'
import { get, post } from '../../../lib/api'
import { SessionList } from './components/SessionList'
import { ChatPanel } from './components/ChatPanel'
import { Timeline } from './components/Timeline'

/**
 * 会话页 三栏布局
 * 左 会话列表 中 对话流 右 执行时间线
 * 员工徽标状态提升到本层 TAKEOVER 事件与时间线联动切换
 */
export default function ChatPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [employees, setEmployees] = useState<EmployeeSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [holderId, setHolderId] = useState<number | null>(null)

  const loadSessions = useCallback(async () => {
    const list = await get<SessionSummary[]>('/sessions')
    setSessions(list)
  }, [])

  // 初次加载会话与员工
  useEffect(() => {
    loadSessions().catch(() => setSessions([]))
    get<EmployeeSummary[]>('/employees')
      .then(setEmployees)
      .catch(() => setEmployees([]))
  }, [loadSessions])

  const selected = useMemo(() => sessions.find((s) => s.id === selectedId) ?? null, [sessions, selectedId])
  const holder = useMemo(() => employees.find((e) => e.id === holderId) ?? null, [employees, holderId])

  // 选中会话或列表刷新时 徽标回落到会话当前持有者
  useEffect(() => {
    setHolderId(selected?.currentParticipantId ?? null)
  }, [selectedId, sessions, selected])

  // 默认选中第一条
  useEffect(() => {
    if (selectedId === null && sessions.length > 0) {
      setSelectedId(sessions[0]?.id ?? null)
    }
  }, [sessions, selectedId])

  const onCreate = useCallback(async (payload: { title: string; participantEmployeeIds: number[] }) => {
    const s = await post<SessionSummary>('/sessions', payload)
    setSessions((prev) => [s, ...prev])
    setSelectedId(s.id)
  }, [])

  const onHolderChange = useCallback((id: number) => setHolderId(id), [])
  const onTurnFinished = useCallback(() => {
    loadSessions().catch(() => undefined)
  }, [loadSessions])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0, 1fr) 300px', height: '100%' }}>
      <SessionList
        sessions={sessions}
        selectedId={selectedId}
        onSelect={setSelectedId}
        employees={employees}
        onCreate={onCreate}
      />

      {selected ? (
        <ChatPanel
          key={`chat-${selected.id}`}
          session={selected}
          holder={holder}
          employees={employees}
          onTurnFinished={onTurnFinished}
        />
      ) : (
        <div className="empty">选择或新建一个会话</div>
      )}

      {selected ? (
        <Timeline key={`timeline-${selected.id}`} sessionId={selected.id} employees={employees} onHolderChange={onHolderChange} />
      ) : (
        <div style={{ borderLeft: '1px solid var(--border)' }} />
      )}
    </div>
  )
}
