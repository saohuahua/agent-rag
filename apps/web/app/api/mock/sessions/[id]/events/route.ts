import { notFound, requireMember } from '../../../_lib/http'
import { db } from '../../../_lib/store'
import type { ExecutionEventItem } from '@agent-rag/shared'

/**
 * 执行事件 SSE 时间线数据源
 * 支持 ?afterId= 断线续传 先回放历史再订阅新事件
 * turns 流写事件时通过 store 的订阅者集合实时推到这里
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  const { id } = await ctx.params
  const session = db.sessions.find((s) => s.id === Number(id) && s.enterpriseId === member.enterpriseId)
  if (!session) return notFound()

  const afterId = Number(new URL(req.url).searchParams.get('afterId') ?? 0)

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // 事件转 SSE 行 id 行用于断线续传
      const write = (ev: ExecutionEventItem) => {
        controller.enqueue(encoder.encode(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`))
      }

      // 回放 afterId 之后的历史事件
      const history = db.events
        .filter((e) => e.sessionId === session.id && e.id > afterId)
        .sort((a, b) => a.id - b.id)
        .map((e) => ({ id: e.id, type: e.type, employeeId: e.employeeId, payload: e.payload, createdAt: e.createdAt }))
      for (const ev of history) write(ev)

      // 订阅新事件
      let subs = db.eventSubscribers.get(session.id)
      if (!subs) {
        subs = new Set()
        db.eventSubscribers.set(session.id, subs)
      }
      subs.add(write)

      // 心跳保活 防止代理断连
      const timer = setInterval(() => {
        controller.enqueue(encoder.encode(': ping\n\n'))
      }, 15000)

      // 连接关闭时清理订阅与心跳
      const cleanup = () => {
        clearInterval(timer)
        subs?.delete(write)
      }
      req.signal.addEventListener('abort', cleanup)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
