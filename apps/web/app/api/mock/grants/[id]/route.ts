import { json, notFound, requireAdmin } from '../../_lib/http'
import { db } from '../../_lib/store'

/** 撤销授权 从列表移除 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = requireAdmin(req)
  if (member instanceof Response) return member

  const { id } = await ctx.params
  const idx = db.grants.findIndex((g) => g.id === Number(id) && g.enterpriseId === member.enterpriseId)
  if (idx < 0) return notFound()

  db.grants.splice(idx, 1)
  return json({ ok: true })
}
