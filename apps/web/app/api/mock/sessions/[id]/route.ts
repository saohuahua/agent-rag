import { json, notFound, requireMember } from '../../_lib/http'
import { db, toSessionDetail } from '../../_lib/store'

/** 会话详情 含消息回放 只允许本租户读取 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  const { id } = await ctx.params
  const session = db.sessions.find((s) => s.id === Number(id) && s.enterpriseId === member.enterpriseId)
  if (!session) return notFound()

  return json(toSessionDetail(session))
}
