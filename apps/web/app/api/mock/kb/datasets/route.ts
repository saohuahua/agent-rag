import { json, badRequest, requireMember } from '../../_lib/http'
import { db, toDatasetSummary, nextIdFor } from '../../_lib/store'
import type { MockDataset } from '../../_lib/store'

/** 数据集列表 按租户过滤 附带文档数统计 */
export async function GET(req: Request): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  const list = db.datasets.filter((d) => d.enterpriseId === member.enterpriseId).map(toDatasetSummary)
  return json(list)
}

/** 建数据集 */
export async function POST(req: Request): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  let body: { name?: string; description?: string }
  try {
    body = await req.json()
  } catch {
    return badRequest('invalid json body')
  }
  const name = body.name?.trim()
  if (!name) return badRequest('name required')

  const ds: MockDataset = {
    id: nextIdFor('ds'),
    enterpriseId: member.enterpriseId,
    name,
    description: body.description?.trim() || null,
  }
  db.datasets.push(ds)

  return json(toDatasetSummary(ds))
}
