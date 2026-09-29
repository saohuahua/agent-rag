import { json } from '../../_lib/http'
import { toMe, currentMember } from '../../_lib/store'

/** 当前登录成员 未登录 401 前端据此判断登录态 */
export async function GET(req: Request): Promise<Response> {
  const member = currentMember(req)
  if (!member) return json({ message: 'unauthorized' }, { status: 401 })
  return json(toMe(member))
}
