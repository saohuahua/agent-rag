import { json, requireMember } from '../_lib/http'
import { db } from '../_lib/store'

/** 平台级技能清单 模板起草绑定技能用 */
export async function GET(req: Request): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  return json(db.skills)
}
