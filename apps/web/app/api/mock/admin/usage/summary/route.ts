import { json, requireMember } from '../../../_lib/http'
import { db } from '../../../_lib/store'

/**
 * 成本报表 usage 汇总 按日/别名/企业
 * mock 按当前租户过滤 演示只看本企业成本
 */
export async function GET(req: Request): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  const groups = db.usage
    .filter((u) => u.enterpriseId === member.enterpriseId)
    .sort((a, b) => b.day.localeCompare(a.day) || a.routeAlias.localeCompare(b.routeAlias))

  return json({ groups })
}
