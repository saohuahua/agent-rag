import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { EnvService } from '../config/env.service'
import { ProviderRegistry } from './provider-registry'
import { z } from 'zod'

const ProviderCreateSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['LLM', 'EMBEDDING']),
  baseUrl: z.string().min(1),
  apiKeyEnv: z.string().min(1),
  enabled: z.boolean().optional(),
})

const ProviderUpdateSchema = z.object({
  baseUrl: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
})

const RouteCreateSchema = z.object({
  alias: z.string().min(1),
  providerId: z.number().int().positive(),
  upstreamModel: z.string().min(1),
  priority: z.number().int().optional(),
  priceInPerMTok: z.number().nonnegative().optional(),
  priceOutPerMTok: z.number().nonnegative().optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
})

const RouteUpdateSchema = z.object({
  alias: z.string().min(1).optional(),
  providerId: z.number().int().positive().optional(),
  upstreamModel: z.string().min(1).optional(),
  priority: z.number().int().optional(),
  priceInPerMTok: z.number().nonnegative().optional(),
  priceOutPerMTok: z.number().nonnegative().optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
})

/** 成本汇总行 raw SQL 产出 */
interface UsageSummaryRow {
  enterpriseId: number | null
  routeAlias: string
  day: string
  calls: number
  inputTokens: number
  outputTokens: number
  costCny: string
}

/**
 * 网关管理端 供演示环境改配置与看成本
 * 鉴权：x-api-key 与 env 的 INTERNAL_API_KEY 比对 该值非空才启用 空则开发模式放行
 */
@Controller('admin')
export class AdminGatewayController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly providers: ProviderRegistry,
  ) {}

  /** 管理端保护 空 key 视为不启用 */
  private assertAdmin(key: string | undefined): void {
    const expected = this.env.INTERNAL_API_KEY
    if (expected && key !== expected) {
      throw new ForbiddenException('invalid x-api-key')
    }
  }

  /**
   * 成本汇总 按企业 别名 日分组
   * 为什么 raw SQL 而非 Prisma groupBy：需要 date_trunc 按天截断
   * Prisma groupBy 只能按原始时间戳分组 做不到按天
   * 无外部字符串拼接 参数经 Prisma.sql 占位 无注入风险
   */
  @Get('usage/summary')
  async summary(
    @Headers('x-api-key') key: string | undefined,
    @Query('enterpriseId') enterpriseId?: string,
  ): Promise<{ groups: UsageSummaryRow[] }> {
    this.assertAdmin(key)

    const eid = enterpriseId !== undefined && enterpriseId !== '' ? Number(enterpriseId) : null

    const groups = await this.prisma.$queryRaw<UsageSummaryRow[]>`
      SELECT
        "enterpriseId" AS "enterpriseId",
        "routeAlias" AS "routeAlias",
        date_trunc('day', "createdAt")::date::text AS "day",
        count(*)::int AS "calls",
        sum("inputTokens")::int AS "inputTokens",
        sum("outputTokens")::int AS "outputTokens",
        sum("costCny")::numeric AS "costCny"
      FROM usage_records
      WHERE (${eid}::int IS NULL OR "enterpriseId" = ${eid}::int)
      GROUP BY 1, 2, 3
      ORDER BY 3 DESC, 4 DESC
    `

    return { groups }
  }

  /** 供应商列表 */
  @Get('providers')
  async listProviders(@Headers('x-api-key') key: string | undefined) {
    this.assertAdmin(key)
    return this.prisma.modelProvider.findMany({ include: { routes: true } })
  }

  /** 新建供应商 */
  @Post('providers')
  async createProvider(@Headers('x-api-key') key: string | undefined, @Body() body: unknown) {
    this.assertAdmin(key)
    const parsed = ProviderCreateSchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map(i => i.message).join('; '))
    }
    const p = parsed.data
    return this.prisma.modelProvider.create({
      data: { name: p.name, kind: p.kind, baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv, enabled: p.enabled ?? true },
    })
  }

  /** 更新供应商 改配置后失效缓存让新配置 30s 内生效 */
  @Patch('providers/:id')
  async updateProvider(
    @Headers('x-api-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    this.assertAdmin(key)
    const parsed = ProviderUpdateSchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map(i => i.message).join('; '))
    }
    const p = parsed.data
    const updated = await this.prisma.modelProvider.update({
      where: { id: Number(id) },
      data: { baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv, enabled: p.enabled },
    })
    this.providers.invalidate()
    return updated
  }

  /** 路由列表 */
  @Get('routes')
  async listRoutes(@Headers('x-api-key') key: string | undefined) {
    this.assertAdmin(key)
    return this.prisma.modelRoute.findMany({ orderBy: [{ alias: 'asc' }, { priority: 'asc' }], include: { provider: true } })
  }

  /** 新建路由 */
  @Post('routes')
  async createRoute(@Headers('x-api-key') key: string | undefined, @Body() body: unknown) {
    this.assertAdmin(key)
    const parsed = RouteCreateSchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map(i => i.message).join('; '))
    }
    const r = parsed.data
    return this.prisma.modelRoute.create({
      data: {
        alias: r.alias,
        providerId: r.providerId,
        upstreamModel: r.upstreamModel,
        priority: r.priority ?? 100,
        priceInPerMTok: new Prisma.Decimal(r.priceInPerMTok ?? 0),
        priceOutPerMTok: new Prisma.Decimal(r.priceOutPerMTok ?? 0),
        maxTokens: r.maxTokens ?? null,
        enabled: r.enabled ?? true,
      },
    })
  }

  /** 更新路由 价格用 Decimal 精写 */
  @Patch('routes/:id')
  async updateRoute(
    @Headers('x-api-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    this.assertAdmin(key)
    const parsed = RouteUpdateSchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map(i => i.message).join('; '))
    }
    const r = parsed.data
    return this.prisma.modelRoute.update({
      where: { id: Number(id) },
      data: {
        alias: r.alias,
        providerId: r.providerId,
        upstreamModel: r.upstreamModel,
        priority: r.priority,
        priceInPerMTok: r.priceInPerMTok !== undefined ? new Prisma.Decimal(r.priceInPerMTok) : undefined,
        priceOutPerMTok: r.priceOutPerMTok !== undefined ? new Prisma.Decimal(r.priceOutPerMTok) : undefined,
        maxTokens: r.maxTokens,
        enabled: r.enabled,
      },
    })
  }

  /** 删除路由 */
  @Delete('routes/:id')
  async deleteRoute(@Headers('x-api-key') key: string | undefined, @Param('id') id: string) {
    this.assertAdmin(key)
    await this.prisma.modelRoute.delete({ where: { id: Number(id) } })
    return { ok: true }
  }
}
