import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { InjectQueue } from '@nestjs/bullmq'
import type { Queue } from 'bullmq'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { PrismaService } from '../prisma/prisma.service'
import { DocSourceType, DocStatus } from '../generated/prisma/enums'
import { RetrievalService } from './retrieval.service'
import { EnterpriseContextService } from '../tenant/enterprise-context.service'
import { DOC_INGEST_QUEUE } from './ingest.processor'
import { uploadDir, persistUpload, removeUpload } from './storage'

/** 上传大小上限 20MB */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** mime → 扩展名 白名单 只收 PDF 与 DOCX */
const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
}

/** 建数据集入参 */
const CreateDatasetSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  enterpriseId: z.number().int().positive().optional(),
})

/** 上传请求的文本字段（multipart 里为字符串） */
const UploadBodySchema = z.object({
  enterpriseId: z.coerce.number().int().positive().optional(),
})

/** 检索入参 测试台 */
const SearchSchema = z.object({
  query: z.string().min(1).max(2000),
  datasetId: z.number().int().positive().optional(),
  topK: z.number().int().min(1).max(50).optional(),
  channel: z.enum(['auto', 'vector', 'lexical']).optional(),
  enterpriseId: z.number().int().positive().optional(),
})

/** multer 落盘后的文件对象最小形状 */
const UploadedFileSchema = z.object({
  originalname: z.string(),
  mimetype: z.string(),
  size: z.number(),
  path: z.string(),
})

/**
 * 知识库控制器 上传/状态/检索测试台
 * 租户隔离：D 任务未完成时上下文桩不可用 测试台靠显式 enterpriseId 跑通
 * D 完成后 Guard 注入的 TenantCtx 优先 显式参数自然被忽略（见 resolveEnterpriseId）
 */
@Controller('kb')
export class KbController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly retrieval: RetrievalService,
    private readonly ctx: EnterpriseContextService,
    @InjectQueue(DOC_INGEST_QUEUE) private readonly queue: Queue,
  ) {}

  /** 建数据集（租户锚点） */
  @Post('datasets')
  async createDataset(@Body() body: unknown) {
    const parsed = CreateDatasetSchema.safeParse(body)
    if (!parsed.success) throw new BadRequestException(issuesOf(parsed.error))

    const enterpriseId = this.resolveEnterpriseId(parsed.data.enterpriseId)
    const ds = await this.prisma.knowledgeDataset.create({
      data: { enterpriseId, name: parsed.data.name, description: parsed.data.description },
    })

    return { id: ds.id, name: ds.name, description: ds.description, enterpriseId: ds.enterpriseId }
  }

  /** 数据集列表（含文档数量统计） */
  @Get('datasets')
  async listDatasets(@Query('enterpriseId', ParseIntPipe) enterpriseId: number) {
    const rows = await this.prisma.knowledgeDataset.findMany({
      where: { enterpriseId },
      include: { _count: { select: { docs: true } } },
      orderBy: { id: 'asc' },
    })

    return rows.map(d => ({ id: d.id, name: d.name, description: d.description, docCount: d._count.docs }))
  }

  /** 上传 PDF/DOCX 立即返回 docId 异步入库 */
  @Post('datasets/:id/docs')
  @UseInterceptors(FileInterceptor('file', { dest: uploadDir(), limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async uploadDoc(
    @Param('id', ParseIntPipe) datasetId: number,
    @UploadedFile() file: unknown,
    @Body() body: unknown,
  ) {
    const bodyParsed = UploadBodySchema.safeParse(body ?? {})
    if (!bodyParsed.success) throw new BadRequestException(issuesOf(bodyParsed.error))
    const enterpriseId = this.resolveEnterpriseId(bodyParsed.data.enterpriseId)

    // 文件对象校验
    const fileParsed = UploadedFileSchema.safeParse(file)
    if (!fileParsed.success) throw new BadRequestException('invalid file upload')

    // mime 白名单
    const ext = MIME_EXT[fileParsed.data.mimetype]
    if (!ext) {
      removeUpload(path.basename(fileParsed.data.path))
      throw new BadRequestException(`unsupported mime type: ${fileParsed.data.mimetype} (pdf/docx only)`)
    }

    // 数据集必须属于该租户
    const dataset = await this.prisma.knowledgeDataset.findUnique({ where: { id: datasetId } })
    if (!dataset || dataset.enterpriseId !== enterpriseId) {
      removeUpload(path.basename(fileParsed.data.path))
      throw new NotFoundException('dataset not found')
    }

    // checksum 去重 sha256
    const checksum = createHash('sha256').update(fs.readFileSync(fileParsed.data.path)).digest('hex')

    const dup = await this.prisma.knowledgeDoc.findUnique({ where: { datasetId_checksum: { datasetId, checksum } } })
    if (dup) {
      removeUpload(path.basename(fileParsed.data.path))
      throw new ConflictException('duplicate document (same checksum already in dataset)')
    }

    // 落盘为正式存储键
    const storageKey = persistUpload(fileParsed.data.path, ext)

    // 标题取原始文件名去扩展名
    const title = fileParsed.data.originalname.replace(/\.[^.]+$/, '') || storageKey

    const doc = await this.prisma.knowledgeDoc.create({
      data: {
        datasetId,
        enterpriseId,
        title,
        sourceType: DocSourceType.UPLOAD,
        storageKey,
        mimeType: fileParsed.data.mimetype,
        sizeBytes: fileParsed.data.size,
        checksum,
        status: DocStatus.UPLOADED,
        uploadedBy: 0,
      },
    })

    // 入队 jobId=docId 幂等 attempts=3 指数退避 3s
    await this.queue.add(DOC_INGEST_QUEUE, { docId: doc.id }, {
      jobId: String(doc.id),
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
    })

    // 条件转 QUEUED 若 worker 已抢先转 PARSING 则不覆盖
    await this.prisma.knowledgeDoc.updateMany({
      where: { id: doc.id, status: DocStatus.UPLOADED },
      data: { status: DocStatus.QUEUED },
    })

    return { docId: doc.id, status: DocStatus.QUEUED }
  }

  /** 文档状态轮询 前端上传进度 */
  @Get('docs/:id')
  async getDoc(@Param('id', ParseIntPipe) id: number) {
    const doc = await this.prisma.knowledgeDoc.findUnique({
      where: { id },
      select: { id: true, title: true, status: true, chunkCount: true, parseError: true },
    })
    if (!doc) throw new NotFoundException('doc not found')
    return doc
  }

  /** 检索测试台 返回双路名次与融合分 供可视化 */
  @Post('search')
  async search(@Body() body: unknown) {
    const parsed = SearchSchema.safeParse(body)
    if (!parsed.success) throw new BadRequestException(issuesOf(parsed.error))

    const enterpriseId = this.resolveEnterpriseId(parsed.data.enterpriseId)
    let hits = await this.retrieval.hybridSearch({
      enterpriseId,
      query: parsed.data.query,
      topK: parsed.data.topK,
      channel: parsed.data.channel,
    })

    // datasetId 过滤为契约外扩展 检索契约签名不变 这里按 doc→dataset 映射后置过滤
    if (parsed.data.datasetId !== undefined) {
      const docs = await this.prisma.knowledgeDoc.findMany({
        where: { datasetId: parsed.data.datasetId, enterpriseId },
        select: { id: true },
      })
      const allowed = new Set(docs.map(d => d.id))
      hits = hits.filter(h => allowed.has(h.docId))
    }

    return { hits }
  }

  /**
   * 解析租户 id 优先请求上下文 测试台降级到显式参数
   * 为什么降级：D 任务未完成 上下文桩抛 NOT_IMPLEMENTED 测试台靠显式参数跑通
   * D 完成后 Guard 注入上下文 显式参数自然被忽略
   * @param explicit 显式参数（可选）
   */
  private resolveEnterpriseId(explicit?: number): number {
    try {
      const cur = this.ctx.current()
      if (cur) return cur.enterpriseId
    } catch {
      // 上下文桩未实现 忽略 走显式参数
    }
    if (explicit !== undefined) return explicit
    throw new BadRequestException('enterpriseId required (tenant guard not wired yet)')
  }
}

/** zod 错误转英文消息 */
function issuesOf(e: z.ZodError): string {
  return e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
}
