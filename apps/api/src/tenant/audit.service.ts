import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { EnterpriseContextService } from './enterprise-context.service'
import type { Prisma } from '../generated/prisma/client'

/** 审计写入条目 与 AuditLog 表字段一一对应 */
export interface AuditEntry {
  action: string
  targetType: string
  targetId: number
  before?: unknown
  after?: unknown
  reason?: string
  /** 显式覆盖归属企业 平台级动作传 null（默认取当前上下文企业） */
  enterpriseId?: number | null
}

/**
 * 审计统一写入服务：模板/包发布、订阅、升级、授权、邀请等关键动作都走这里
 * 为什么 AuditLog 不进租户扩展硬过滤清单：enterpriseId 可空 是横切表（平台级动作无租户）
 *   故写入时显式带 enterpriseId 读取时显式按当前企业过滤（list 方法）
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: EnterpriseContextService,
  ) {}

  /**
   * 写入一条审计 归属企业默认当前上下文 可显式覆盖
   * @param entry 审计条目
   */
  async write(entry: AuditEntry): Promise<void> {
    const ctxTenant = this.ctx.current()
    const enterpriseId = entry.enterpriseId !== undefined ? entry.enterpriseId : (ctxTenant?.enterpriseId ?? null)
    const actorMemberId = ctxTenant?.memberId ?? null

    await this.prisma.auditLog.create({
      data: {
        enterpriseId,
        actorMemberId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        // Json 可空字段用 undefined 省略（Prisma 7 null 需 JsonNull 对象枚举 这里语义是「无」）
        beforeJson: entry.before === undefined ? undefined : toJson(entry.before),
        afterJson: entry.after === undefined ? undefined : toJson(entry.after),
        reason: entry.reason ?? null,
      },
    })
  }

  /**
   * 当前企业审计列表（按 action/targetType 过滤 默认倒序取最近 100 条）
   * @param filter 过滤条件
   * @param limit 条数上限
   */
  async list(filter: { action?: string; targetType?: string } = {}, limit = 100): Promise<unknown[]> {
    const ctxTenant = this.ctx.require()
    const rows = await this.prisma.auditLog.findMany({
      where: {
        enterpriseId: ctxTenant.enterpriseId,
        ...(filter.action ? { action: filter.action } : {}),
        ...(filter.targetType ? { targetType: filter.targetType } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit,
    })

    // 展平 Json 字段返回给前端 便于直接展示 before/after
    return rows.map(r => ({
      id: r.id,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      actorMemberId: r.actorMemberId,
      before: r.beforeJson,
      after: r.afterJson,
      reason: r.reason,
      createdAt: r.createdAt,
    }))
  }
}

/** 任意值转 Prisma Json 输入 走 JSON 序列化保证可存储（Date/Decimal 转字符串） */
function toJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue
}
