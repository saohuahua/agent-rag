import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { EnterpriseContextService } from '../enterprise-context.service'
import { AuditService } from '../audit.service'
import { TenantInvalidStateError, TenantNotFoundError } from '../tenant.errors'
import { TemplateStatus } from '../../generated/prisma/enums'

/** 包内模板清单项 */
export interface PackageItemInput {
  templateSlug: string
  templateVersion: number
}

/**
 * 订阅包服务（平台级商品壳 版本行不可变）
 * 状态机与模板同款：DRAFT → PENDING_REVIEW → PUBLISHED/REJECTED/ARCHIVED
 * 发布后 PackageVersion 不可改 订阅锁定版本号引用 升级=新版本行（规格 §4.5）
 */
@Injectable()
export class PackageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: EnterpriseContextService,
    private readonly audit: AuditService,
  ) {}

  /** 建包壳（slug 唯一） */
  async create(input: { slug: string; name: string; description?: string }) {
    this.ctx.require()
    return this.prisma.subscriptionPackage.create({
      data: { slug: input.slug.trim(), name: input.name.trim(), description: input.description ?? '' },
    })
  }

  /**
   * 给包开新版本（DRAFT）并写入模板清单
   * @param packageId 包 id
   * @param items 模板清单 slug+version 精确锁定（软引用）
   */
  async createVersion(packageId: number, items: PackageItemInput[]) {
    this.ctx.require()
    const pkg = await this.prisma.subscriptionPackage.findFirst({ where: { id: packageId } })
    if (!pkg) {
      throw new TenantNotFoundError('package not found')
    }

    const latest = await this.prisma.packageVersion.findFirst({
      where: { packageId },
      orderBy: { version: 'desc' },
    })
    const version = (latest?.version ?? 0) + 1

    return this.prisma.$transaction(async tx => {
      const ver = await tx.packageVersion.create({
        data: { packageId, version, status: TemplateStatus.DRAFT },
      })
      for (const it of items) {
        await tx.packageItem.create({
          data: { packageVersionId: ver.id, templateSlug: it.templateSlug, templateVersion: it.templateVersion },
        })
      }
      return ver
    })
  }

  /** 提交审核 DRAFT/REJECTED → PENDING_REVIEW */
  async submitVersion(versionId: number) {
    const ver = await this.mustGetVersion(versionId)
    if (ver.status !== TemplateStatus.DRAFT && ver.status !== TemplateStatus.REJECTED) {
      throw new TenantInvalidStateError(`cannot submit package version in status ${ver.status}`)
    }
    const updated = await this.prisma.packageVersion.update({ where: { id: versionId }, data: { status: TemplateStatus.PENDING_REVIEW } })
    await this.audit.write({ action: 'PACKAGE_SUBMIT', targetType: 'PackageVersion', targetId: versionId, after: { version: ver.version }, enterpriseId: null })
    return updated
  }

  /** 发布版本 PENDING_REVIEW → PUBLISHED（平台级动作 审计无企业归属） */
  async publishVersion(versionId: number) {
    const ver = await this.mustGetVersion(versionId)
    if (ver.status !== TemplateStatus.PENDING_REVIEW) {
      throw new TenantInvalidStateError(`cannot publish package version in status ${ver.status}`)
    }
    const updated = await this.prisma.packageVersion.update({
      where: { id: versionId },
      data: { status: TemplateStatus.PUBLISHED, publishedAt: new Date() },
    })
    await this.audit.write({
      action: 'PACKAGE_PUBLISH',
      targetType: 'PackageVersion',
      targetId: versionId,
      before: { status: ver.status },
      after: { status: TemplateStatus.PUBLISHED, version: ver.version },
      enterpriseId: null,
    })
    return updated
  }

  /** 驳回版本 PENDING_REVIEW → REJECTED */
  async rejectVersion(versionId: number, reviewNote: string) {
    const ver = await this.mustGetVersion(versionId)
    if (ver.status !== TemplateStatus.PENDING_REVIEW) {
      throw new TenantInvalidStateError(`cannot reject package version in status ${ver.status}`)
    }
    const updated = await this.prisma.packageVersion.update({
      where: { id: versionId },
      data: { status: TemplateStatus.REJECTED },
    })
    await this.audit.write({
      action: 'PACKAGE_REJECT',
      targetType: 'PackageVersion',
      targetId: versionId,
      before: { status: ver.status },
      after: { status: TemplateStatus.REJECTED, reviewNote },
      enterpriseId: null,
    })
    return updated
  }

  /** 包列表 */
  async listPackages() {
    return this.prisma.subscriptionPackage.findMany({ orderBy: { id: 'asc' } })
  }

  /** 包的全部版本（含清单项）倒序 */
  async listVersions(packageId: number) {
    const vers = await this.prisma.packageVersion.findMany({
      where: { packageId },
      orderBy: { version: 'desc' },
      include: { items: true },
    })
    return vers
  }

  /**
   * 读包的「当前已发布最大版本」订阅用（无 PUBLISHED 返回 null）
   * @param packageId 包 id
   */
  async latestPublishedVersion(packageId: number) {
    return this.prisma.packageVersion.findFirst({
      where: { packageId, status: TemplateStatus.PUBLISHED },
      orderBy: { version: 'desc' },
      include: { items: true },
    })
  }

  private async mustGetVersion(versionId: number) {
    const ver = await this.prisma.packageVersion.findFirst({ where: { id: versionId } })
    if (!ver) {
      throw new TenantNotFoundError('package version not found')
    }
    return ver
  }
}
