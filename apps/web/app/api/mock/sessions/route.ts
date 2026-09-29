import { json, badRequest, requireMember } from '../_lib/http'
import { db, toSessionSummary, nextIdFor } from '../_lib/store'
import type { MockSession } from '../_lib/store'

/** 会话列表 按租户过滤 按最后消息时间倒序 */
export async function GET(req: Request): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  const list = db.sessions
    .filter((s) => s.enterpriseId === member.enterpriseId)
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))
    .map(toSessionSummary)

  return json(list)
}

/**
 * 建会话 校验参与员工都属于当前租户 首个员工即当前持有者
 * @param body { title?, participantEmployeeIds }
 */
export async function POST(req: Request): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  let body: { title?: string; participantEmployeeIds?: number[] }
  try {
    body = await req.json()
  } catch {
    return badRequest('invalid json body')
  }

  const ids = body.participantEmployeeIds ?? []
  if (ids.length === 0) return badRequest('participantEmployeeIds must not be empty')

  // 校验阵容里每个员工都属于本租户 防越权
  const owned = db.employees.filter((e) => e.enterpriseId === member.enterpriseId)
  const ok = ids.every((id) => owned.some((e) => e.id === id))
  if (!ok) return badRequest('participant employee not in tenant')

  const session: MockSession = {
    id: nextIdFor('session'),
    enterpriseId: member.enterpriseId,
    title: body.title?.trim() || null,
    status: 'ACTIVE',
    currentParticipantId: ids[0] ?? null,
    epoch: 0,
    lastMessageAt: new Date().toISOString(),
    participantEmployeeIds: ids,
  }
  db.sessions.push(session)

  return json(toSessionSummary(session))
}
