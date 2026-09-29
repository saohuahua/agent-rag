import { json, badRequest, notFound, requireAdmin } from '../../../_lib/http'
import { db, toTemplateSummary } from '../../../_lib/store'

/** ADMIN 审核发布 PENDING_REVIEW → PUBLISHED 发布后不可改 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = requireAdmin(_req)
  if (member instanceof Response) return member

  const { id } = await ctx.params
  const tpl = db.templates.find((t) => t.id === Number(id))
  if (!tpl) return notFound()

  if (tpl.status !== 'PENDING_REVIEW') {
    return badRequest(`cannot publish from status ${tpl.status}`)
  }
  tpl.status = 'PUBLISHED'
  tpl.publishedAt = new Date().toISOString()

  return json(toTemplateSummary(tpl))
}
