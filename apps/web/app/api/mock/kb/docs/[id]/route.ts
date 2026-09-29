import { json, notFound, requireMember } from '../../../_lib/http'
import { db, toDocSummary, advanceDocStatus } from '../../../_lib/store'

/** 文档状态轮询 每次读时推进模拟解析进度 供前端上传进度条 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  const { id } = await ctx.params
  const doc = db.docs.find((d) => d.id === Number(id) && d.enterpriseId === member.enterpriseId)
  if (!doc) return notFound()

  advanceDocStatus(doc)
  return json(toDocSummary(doc))
}
