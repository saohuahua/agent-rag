import { json, badRequest, requireAdmin } from '../_lib/http'
import { db, toTemplateSummary, nextIdFor } from '../_lib/store'
import type { MockTemplate } from '../_lib/store'

/** 模板清单 平台级 全部企业可见 */
export async function GET(req: Request): Promise<Response> {
  const member = requireAdmin(req)
  if (member instanceof Response) return member

  // 按 slug 分组 组内按版本倒序
  const list = [...db.templates].sort((a, b) => a.slug.localeCompare(b.slug) || b.version - a.version)
  return json(list.map(toTemplateSummary))
}

/**
 * 起草模板 DRAFT 版本号取同 slug 最大版本 +1
 * @param body { slug, name, description, systemPrompt, skillBindings, kbBindings }
 */
export async function POST(req: Request): Promise<Response> {
  const member = requireAdmin(req)
  if (member instanceof Response) return member

  let body: {
    slug?: string
    name?: string
    description?: string
    systemPrompt?: string
    skillBindings?: { skillKey: string; configJson: unknown }[]
    kbBindings?: { datasetId: number; kbMode: string }[]
  }
  try {
    body = await req.json()
  } catch {
    return badRequest('invalid json body')
  }

  const slug = body.slug?.trim()
  if (!slug) return badRequest('slug required')
  if (!body.name?.trim()) return badRequest('name required')
  if (!body.systemPrompt?.trim()) return badRequest('systemPrompt required')

  const maxVersion = db.templates
    .filter((t) => t.slug === slug)
    .reduce((acc, t) => Math.max(acc, t.version), 0)

  const tpl: MockTemplate = {
    id: nextIdFor('template'),
    slug,
    version: maxVersion + 1,
    name: body.name.trim(),
    description: body.description?.trim() ?? '',
    systemPrompt: body.systemPrompt.trim(),
    avatar: null,
    status: 'DRAFT',
    reviewNote: null,
    publishedAt: null,
    skillBindings: body.skillBindings ?? [],
    kbBindings: body.kbBindings ?? [],
  }
  db.templates.push(tpl)

  return json(toTemplateSummary(tpl))
}
