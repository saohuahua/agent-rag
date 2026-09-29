import { json, badRequest, requireAdmin } from '../_lib/http'
import { db, toGrantSummary, nextIdFor } from '../_lib/store'

/** 当前租户授权列表 */
export async function GET(req: Request): Promise<Response> {
  const member = requireAdmin(req)
  if (member instanceof Response) return member

  const list = db.grants.filter((g) => g.enterpriseId === member.enterpriseId).map(toGrantSummary)
  return json(list)
}

/**
 * 新增授权 三 scope 企业/部门/成员
 * @param body { employeeId, scopeType, scopeId? }
 */
export async function POST(req: Request): Promise<Response> {
  const member = requireAdmin(req)
  if (member instanceof Response) return member

  let body: { employeeId?: number; scopeType?: 'ENTERPRISE' | 'DEPARTMENT' | 'MEMBER'; scopeId?: number | null }
  try {
    body = await req.json()
  } catch {
    return badRequest('invalid json body')
  }

  if (!body.employeeId) return badRequest('employeeId required')
  if (!body.scopeType) return badRequest('scopeType required')
  if (body.scopeType !== 'ENTERPRISE' && !body.scopeId) return badRequest('scopeId required for department/member scope')

  // 员工必须属于本租户
  const emp = db.employees.find((e) => e.id === body.employeeId && e.enterpriseId === member.enterpriseId)
  if (!emp) return badRequest('employee not in tenant')

  const grant = {
    id: nextIdFor('grant'),
    enterpriseId: member.enterpriseId,
    employeeId: body.employeeId,
    scopeType: body.scopeType,
    scopeId: body.scopeType === 'ENTERPRISE' ? null : (body.scopeId ?? null),
    status: 'ACTIVE',
  }
  db.grants.push(grant)

  return json(toGrantSummary(grant))
}
