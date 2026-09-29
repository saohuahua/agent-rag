import { json, badRequest, notFound, requireMember } from '../../../_lib/http'
import { db, toSubscriptionSummary, nextIdFor } from '../../../_lib/store'
import type { UpgradeDiff } from '@agent-rag/shared'

/** 比较两版包内清单 产出 added/removed/changed */
function diffItems(
  from: { templateSlug: string; templateVersion: number }[],
  to: { templateSlug: string; templateVersion: number }[],
): { added: UpgradeDiff['added']; removed: UpgradeDiff['removed']; changed: UpgradeDiff['changed'] } {
  const fromMap = new Map(from.map((i) => [i.templateSlug, i.templateVersion]))
  const toMap = new Map(to.map((i) => [i.templateSlug, i.templateVersion]))

  const added = to.filter((i) => !fromMap.has(i.templateSlug))
  const removed = from.filter((i) => !toMap.has(i.templateSlug))
  const changed = to
    .filter((i) => fromMap.has(i.templateSlug) && fromMap.get(i.templateSlug) !== i.templateVersion)
    .map((i) => ({ templateSlug: i.templateSlug, from: fromMap.get(i.templateSlug) as number, to: i.templateVersion }))

  return { added, removed, changed }
}

/**
 * 订阅升级
 * confirm 未传或非 true 时只返回 diff 预览 不落库
 * confirm=true 时更新锁定版本并重建员工快照
 * @param body { confirm? }
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  const { id } = await ctx.params
  const sub = db.subscriptions.find((s) => s.id === Number(id) && s.enterpriseId === member.enterpriseId)
  if (!sub) return notFound()

  const pkg = db.packages.find((p) => p.id === sub.packageId)
  if (!pkg) return notFound()

  const from = pkg.versions.find((v) => v.version === sub.lockedPackageVersion)
  const to = pkg.versions.find((v) => v.status === 'PUBLISHED')
  if (!from || !to) return badRequest('no published version to upgrade to')
  if (to.version === sub.lockedPackageVersion) return badRequest('already on latest version')

  const { added, removed, changed } = diffItems(from.items, to.items)
  const diff: UpgradeDiff = { fromVersion: sub.lockedPackageVersion, toVersion: to.version, added, removed, changed }

  let body: { confirm?: boolean }
  try {
    body = await req.json()
  } catch {
    return badRequest('invalid json body')
  }

  // 预览模式 只给 diff
  if (body.confirm !== true) {
    return json({ diff, applied: false })
  }

  // 确认升级 更新锁定版本与员工快照
  sub.lockedPackageVersion = to.version
  const owned = db.employees.filter((e) => e.subscriptionId === sub.id)

  for (const item of added) {
    const tpl = db.templates.find((t) => t.slug === item.templateSlug && t.version === item.templateVersion)
    const emp = {
      id: nextIdFor('emp'),
      enterpriseId: sub.enterpriseId,
      subscriptionId: sub.id,
      displayName: tpl?.name ?? item.templateSlug,
      avatar: null,
      templateSlug: item.templateSlug,
      templateVersion: item.templateVersion,
      status: 'ACTIVE',
    }
    db.employees.push(emp)
    db.grants.push({ id: nextIdFor('grant'), enterpriseId: sub.enterpriseId, employeeId: emp.id, scopeType: 'ENTERPRISE', scopeId: null, status: 'ACTIVE' })
  }

  for (const item of removed) {
    const emp = owned.find((e) => e.templateSlug === item.templateSlug)
    if (emp) emp.status = 'ARCHIVED'
  }

  for (const item of changed) {
    const emp = owned.find((e) => e.templateSlug === item.templateSlug)
    if (emp) emp.templateVersion = item.to
  }

  return json({ diff, applied: true, subscription: toSubscriptionSummary(sub) })
}
