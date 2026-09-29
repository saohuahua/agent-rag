import { json, requireMember } from '../../_lib/http'
import { buildDeptTree } from '../../_lib/store'

/** 部门树 物化路径已组装成嵌套结构 */
export async function GET(req: Request): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  return json(buildDeptTree(member.enterpriseId))
}
