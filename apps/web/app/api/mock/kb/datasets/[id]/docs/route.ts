import { json, badRequest, notFound, requireMember } from '../../../../_lib/http'
import { db, toDocSummary, advanceDocStatus, nextIdFor } from '../../../../_lib/store'
import type { MockDoc } from '../../../../_lib/store'

/** 允许的上传类型 */
const ALLOWED = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
/** 大小上限 20MB */
const MAX_SIZE = 20 * 1024 * 1024

/**
 * 某数据集下的文档列表 读取时推进各文档模拟解析状态
 * 前端文档表格据此渲染状态徽标
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  const { id } = await ctx.params
  const ds = db.datasets.find((d) => d.id === Number(id) && d.enterpriseId === member.enterpriseId)
  if (!ds) return notFound()

  const docs = db.docs
    .filter((d) => d.datasetId === ds.id)
    .map((d) => {
      advanceDocStatus(d)
      return toDocSummary(d)
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return json(docs)
}

/**
 * 上传文档 multipart/form-data 单文件
 * 校验 mime 与大小 建立 UPLOADED 文档后立即返回 docId 状态轮询走 /kb/docs/:id
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  const { id } = await ctx.params
  const ds = db.datasets.find((d) => d.id === Number(id) && d.enterpriseId === member.enterpriseId)
  if (!ds) return notFound()

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return badRequest('multipart form required')
  }

  const file = form.get('file')
  if (!(file instanceof File)) return badRequest('file field required')

  if (!ALLOWED.has(file.type)) return badRequest('only PDF and DOCX are allowed')
  if (file.size > MAX_SIZE) return badRequest('file exceeds 20MB limit')

  const doc: MockDoc = {
    id: nextIdFor('doc'),
    datasetId: ds.id,
    enterpriseId: member.enterpriseId,
    title: file.name,
    status: 'UPLOADED',
    parseError: null,
    chunkCount: 0,
    sizeBytes: file.size,
    mimeType: file.type,
    sourceType: 'UPLOAD',
    storageKey: `s3://mock/${file.name}`,
    checksum: `${file.name}:${file.size}`,
    uploadedBy: member.id,
    createdAt: new Date().toISOString(),
    statusT0: Date.now(),
  }
  db.docs.push(doc)

  return json({ docId: doc.id, status: doc.status })
}
