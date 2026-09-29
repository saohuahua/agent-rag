'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import type { UIMessage } from 'ai'
import type { ChatMessageItem, EmployeeSummary, SessionSummary } from '@agent-rag/shared'
import { get, chatTurnUrl } from '../../../../lib/api'
import { EmployeeBadge } from './EmployeeBadge'

/** 文本 part 形状 与 AI SDK TextUIPart 一致 */
interface TextPart {
  type: 'text'
  text: string
}

/** 从服务端回放消息转 UIMessage role 与 parts 对齐 AI SDK */
function toUIMessage(m: ChatMessageItem): UIMessage {
  return {
    id: m.id,
    role: m.role === 'USER' ? 'user' : 'assistant',
    // 服务端存的就是 text part 数组 此断言安全
    parts: m.parts as UIMessage['parts'],
  }
}

/** 取最后一条用户文本 作为 turn 请求体 message */
function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'user') {
      const part = m.parts.find((p) => p.type === 'text') as TextPart | undefined
      if (part?.text) return part.text
    }
  }
  return ''
}

/** 从消息 parts 提取纯文本 渲染用 */
function messageText(m: UIMessage): string {
  return m.parts
    .map((p) => (p.type === 'text' ? (p as TextPart).text : ''))
    .filter(Boolean)
    .join('')
}

/**
 * 对话主面板 useChat 打字机流式渲染
 * transport 指向本会话 turn 流 请求体经 prepareSendMessagesRequest 压成 { message }
 * @param session 当前会话摘要
 * @param holder 当前持有员工 徽标展示
 * @param employees 可 @ 的员工列表
 * @param onTurnFinished turn 完成后通知刷新会话列表
 */
export function ChatPanel({
  session,
  holder,
  employees,
  onTurnFinished,
}: {
  session: SessionSummary
  holder: EmployeeSummary | null
  employees: EmployeeSummary[]
  onTurnFinished?: () => void
}) {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [mention, setMention] = useState<EmployeeSummary[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  // 每条 turn 请求体压成后端契约的 { message }
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: chatTurnUrl(session.id),
        prepareSendMessagesRequest: ({ messages }) => ({ body: { message: lastUserText(messages) } }),
      }),
    [session.id],
  )

  const { messages, setMessages, sendMessage, status } = useChat({
    id: `session-${session.id}`,
    transport,
    onFinish: () => onTurnFinished?.(),
  })

  // 拉取会话历史 回放为初始消息
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    get<{ messages: ChatMessageItem[] }>(`/sessions/${session.id}`)
      .then((d) => {
        if (!cancelled) setMessages(d.messages.map(toUIMessage))
      })
      .catch(() => {
        if (!cancelled) setMessages([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [session.id, setMessages])

  // 新消息滚到底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const busy = status === 'streaming' || status === 'submitted'

  // @ 提及过滤 输入含 @ 时弹出候选
  function onInputChange(value: string) {
    setInput(value)
    const idx = value.lastIndexOf('@')
    if (idx >= 0) {
      const q = value.slice(idx + 1)
      setMention(employees.filter((e) => e.displayName.includes(q)).slice(0, 5))
    } else {
      setMention([])
    }
  }

  function pickMention(e: EmployeeSummary) {
    const idx = input.lastIndexOf('@')
    const next = input.slice(0, idx + 1) + e.displayName + ' '
    setInput(next)
    setMention([])
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setMention([])
    try {
      await sendMessage({ text })
    } catch {
      // 发送失败提示 用户可重试
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      {/* 顶部 员工徽标 + @ 提示 */}
      <div className="row-between" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="muted small">当前员工</span>
          <EmployeeBadge employee={holder} />
        </div>
        <span className="hint">输入 @ 可 @ 员工转接</span>
      </div>

      {/* 消息流 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
        {loading && (
          <div className="empty">
            <div className="spin" style={{ margin: '0 auto 8px' }} />
            加载历史…
          </div>
        )}
        {!loading && messages.length === 0 && (
          <div className="empty">开始第一轮对话吧 试试「我买的口红过敏了能退吗」或「这个宣传语合规吗」</div>
        )}
        {messages.map((m) => {
          const isUser = m.role === 'user'
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: 12 }}>
              <div
                style={{
                  maxWidth: '72%',
                  padding: '10px 14px',
                  borderRadius: 12,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: isUser ? 'var(--accent)' : 'var(--bg-elevated)',
                  color: isUser ? '#fff' : 'var(--text)',
                  border: isUser ? 'none' : '1px solid var(--border)',
                }}
              >
                {messageText(m) || (busy && m.id === messages[messages.length - 1]?.id ? '…' : '')}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <form onSubmit={onSubmit} style={{ position: 'relative', padding: '12px 14px', borderTop: '1px solid var(--border)' }}>
        {mention.length > 0 && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 14,
              right: 14,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: 'var(--shadow)',
              zIndex: 10,
            }}
          >
            {mention.map((e) => (
              <button
                key={e.id}
                type="button"
                className="btn btn-sm"
                style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent' }}
                onClick={() => pickMention(e)}
              >
                {e.displayName} · {e.templateSlug}
              </button>
            ))}
          </div>
        )}
        <div className="row" style={{ gap: 8 }}>
          <textarea
            className="textarea"
            style={{ flex: 1, minHeight: 44, resize: 'none' }}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder="输入消息 回车发送"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onSubmit(e)
              }
            }}
          />
          <button className="btn btn-primary" disabled={busy || !input.trim()} type="submit">
            {busy ? '生成中…' : '发送'}
          </button>
        </div>
      </form>
    </div>
  )
}
