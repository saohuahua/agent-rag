import { json, badRequest, notFound, requireAdmin } from '../../../../../_lib/http'
import { db, toPackageSummary } from '../../../../../_lib/store'

/** 发布包版本 DRAFT → PUBLISHED 发布后不可变 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string; version: string }> }): Promise<Response> {
  const member = requireAdmin(_req)
  if (member instanceof Response) return member

  const { id, version } = await ctx.params
  const pkg = db.packages.find((p) => p.id === Number(id))
  if (!pkg) return notFound()

  const ver = pkg.versions.find((v) => v.version === Number(version))
  if (!ver) return notFound()

  if (ver.status !== 'DRAFT') return badRequest(`cannot publish from status ${ver.status}`)
  ver.status = 'PUBLISHED'
  ver.publishedAt = new Date().toISOString()

  return json(toPackageSummary(pkg))
}
