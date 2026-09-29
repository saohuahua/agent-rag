import { json, badRequest, requireAdmin } from '../_lib/http'
import { db, toPackageSummary, nextIdFor } from '../_lib/store'
import type { MockPackage } from '../_lib/store'

/** 订阅包清单 平台级 */
export async function GET(req: Request): Promise<Response> {
  const member = requireAdmin(req)
  if (member instanceof Response) return member

  return json(db.packages.map(toPackageSummary))
}

/** 建包 无版本的包壳 */
export async function POST(req: Request): Promise<Response> {
  const member = requireAdmin(req)
  if (member instanceof Response) return member

  let body: { slug?: string; name?: string; description?: string }
  try {
    body = await req.json()
  } catch {
    return badRequest('invalid json body')
  }
  const slug = body.slug?.trim()
  if (!slug) return badRequest('slug required')
  if (!body.name?.trim()) return badRequest('name required')

  if (db.packages.some((p) => p.slug === slug)) return badRequest('slug already exists')

  const pkg: MockPackage = {
    id: nextIdFor('package'),
    slug,
    name: body.name.trim(),
    description: body.description?.trim() ?? '',
    versions: [],
  }
  db.packages.push(pkg)

  return json(toPackageSummary(pkg))
}
