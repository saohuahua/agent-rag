import { json, requireMember } from '../_lib/http'
import { db, toMemberSummary } from '../_lib/store'

/** 当前租户成员列表 部门授权页用 */
export async function GET(req: Request): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  const list = db.members.filter((m) => m.enterpriseId === member.enterpriseId).map(toMemberSummary)
  return json(list)
}
