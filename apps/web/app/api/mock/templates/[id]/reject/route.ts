import { json, badRequest, notFound, requireAdmin } from '../../../_lib/http'
import { db, toTemplateSummary } from '../../../_lib/store'

/** ADMIN 驳回 PENDING_REVIEW → REJECTED 记录审核意见 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = requireAdmin(req)
  if (member instanceof Response) return member

  const { id } = await ctx.params
  const tpl = db.templates.find((t) => t.id === Number(id))
  if (!tpl) return notFound()

  if (tpl.status !== 'PENDING_REVIEW') {
    return badRequest(`cannot reject from status ${tpl.status}`)
  }

  let body: { reviewNote?: string }
  try {
    body = await req.json()
  } catch {
    return badRequest('invalid json body')
  }

  tpl.status = 'REJECTED'
  tpl.reviewNote = body.reviewNote?.trim() || '未说明原因'

  return json(toTemplateSummary(tpl))
}
