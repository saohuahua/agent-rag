import { json, badRequest, requireMember } from '../_lib/http'
import { db, toSubscriptionSummary, nextIdFor } from '../_lib/store'
import type { MockSubscription, MockEmployee } from '../_lib/store'

/** 当前租户的订阅列表 附带锁定版本与员工 */
export async function GET(req: Request): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  const list = db.subscriptions.filter((s) => s.enterpriseId === member.enterpriseId).map(toSubscriptionSummary)
  return json(list)
}

/**
 * 订阅 锁定包当前已发布最大版本 并按包内清单 provision 员工
 * 默认 ENTERPRISE scope 授权
 * @param body { packageId }
 */
export async function POST(req: Request): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  let body: { packageId?: number }
  try {
    body = await req.json()
  } catch {
    return badRequest('invalid json body')
  }
  const packageId = body.packageId
  if (!packageId) return badRequest('packageId required')

  const pkg = db.packages.find((p) => p.id === packageId)
  if (!pkg) return badRequest('package not found')

  const latest = pkg.versions.find((v) => v.status === 'PUBLISHED')
  if (!latest) return badRequest('package has no published version')

  const sub: MockSubscription = {
    id: nextIdFor('sub'),
    enterpriseId: member.enterpriseId,
    packageId,
    lockedPackageVersion: latest.version,
    status: 'ACTIVE',
    startedAt: new Date().toISOString(),
    expiresAt: null,
  }
  db.subscriptions.push(sub)

  // provision 员工 每项一条 默认企业级授权
  for (const item of latest.items) {
    const tpl = db.templates.find((t) => t.slug === item.templateSlug && t.version === item.templateVersion)
    const emp: MockEmployee = {
      id: nextIdFor('emp'),
      enterpriseId: member.enterpriseId,
      subscriptionId: sub.id,
      displayName: tpl?.name ?? item.templateSlug,
      avatar: null,
      templateSlug: item.templateSlug,
      templateVersion: item.templateVersion,
      status: 'ACTIVE',
    }
    db.employees.push(emp)
    db.grants.push({
      id: nextIdFor('grant'),
      enterpriseId: member.enterpriseId,
      employeeId: emp.id,
      scopeType: 'ENTERPRISE',
      scopeId: null,
      status: 'ACTIVE',
    })
  }

  return json(toSubscriptionSummary(sub))
}
