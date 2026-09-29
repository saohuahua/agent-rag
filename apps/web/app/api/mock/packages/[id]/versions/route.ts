import { json, badRequest, notFound, requireAdmin } from '../../../_lib/http'
import { db, toPackageSummary } from '../../../_lib/store'

/**
 * 发新版本 版本号 = 当前最大 +1 状态 DRAFT
 * @param body { items: [{templateSlug, templateVersion}] }
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = requireAdmin(req)
  if (member instanceof Response) return member

  const { id } = await ctx.params
  const pkg = db.packages.find((p) => p.id === Number(id))
  if (!pkg) return notFound()

  let body: { items?: { templateSlug: string; templateVersion: number }[] }
  try {
    body = await req.json()
  } catch {
    return badRequest('invalid json body')
  }
  const items = body.items ?? []
  if (items.length === 0) return badRequest('items must not be empty')

  const maxVersion = pkg.versions.reduce((acc, v) => Math.max(acc, v.version), 0)
  pkg.versions.push({ version: maxVersion + 1, status: 'DRAFT', publishedAt: null, items })

  return json(toPackageSummary(pkg))
}
