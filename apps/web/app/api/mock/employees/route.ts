import { json, requireMember } from '../_lib/http'
import { db, toEmployee } from '../_lib/store'

/** 当前租户的数字员工列表 会话选阵容与 @ 提及用 */
export async function GET(req: Request): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  const list = db.employees.filter((e) => e.enterpriseId === member.enterpriseId).map(toEmployee)
  return json(list)
}
