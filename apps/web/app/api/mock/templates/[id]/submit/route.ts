import { json, badRequest, notFound, requireAdmin } from '../../../_lib/http'
import { db, toTemplateSummary } from '../../../_lib/store'

/** 提交审核 DRAFT/REJECTED → PENDING_REVIEW */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = requireAdmin(_req)
  if (member instanceof Response) return member

  const { id } = await ctx.params
  const tpl = db.templates.find((t) => t.id === Number(id))
  if (!tpl) return notFound()

  if (tpl.status !== 'DRAFT' && tpl.status !== 'REJECTED') {
    return badRequest(`cannot submit from status ${tpl.status}`)
  }
  tpl.status = 'PENDING_REVIEW'

  return json(toTemplateSummary(tpl))
}
