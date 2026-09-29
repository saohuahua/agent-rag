import { json, badRequest, requireMember } from '../../_lib/http'
import { mockSearchHits } from '../../_lib/store'

/**
 * 检索测试台 双路召回 mock
 * 返回命中数组 每项带向量路/词法路名次与 RRF 融合分 供前端并排可视化
 */
export async function POST(req: Request): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  let body: { query?: string; datasetId?: number; topK?: number }
  try {
    body = await req.json()
  } catch {
    return badRequest('invalid json body')
  }

  const query = body.query?.trim()
  if (!query) return badRequest('query required')

  const hits = mockSearchHits(query, member.enterpriseId)
  const topK = body.topK ?? 8
  // RRF 融合分降序取 topK
  const sorted = [...hits].sort((a, b) => b.rrfScore - a.rrfScore).slice(0, topK)

  return json({ hits: sorted, channel: 'auto' })
}
