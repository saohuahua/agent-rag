import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { EnterpriseContextService } from './enterprise-context.service'
import { AuditService } from './audit.service'
import { PackageService } from './package/package.service'
import { TenantConflictError, TenantInvalidStateError, TenantNotFoundError } from './tenant.errors'

/** 清单项差异 */
export interface ItemDiff {
  added: Array<{ templateSlug: string; templateVersion: number }>
  removed: Array<{ templateSlug: string; templateVersion: number }>
  changed: Array<{ templateSlug: string; templateVersion: number }>
}

/**
 * 订阅服务：锁版本 + provision 数字员工 + 升级 diff
 * 核心语义：订阅时读「当前已发布最大版本」写进 lockedPackageVersion 包后续发新版不影响老订阅
 * 升级=显式动作 先返回 diff 预览 传 confirm=true 才执行并写 AuditLog（规格 §4.5）
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: EnterpriseContextService,
    private readonly audit: AuditService,
    private readonly packages: PackageService,
  ) {}

  /**
   * 创建订阅：锁当前已发布最大版本 按清单 provision 员工 默认企业级授权
   * @param packageId 包 id
   * @returns 订阅行
   */
  async create(packageId: number) {
    const ctxTenant = this.ctx.require()
    const ver = await this.packages.latestPublishedVersion(packageId)
    if (!ver) {
      throw new TenantInvalidStateError('package has no published version')
    }

    // 同企业同包只能订阅一次（unique 兜底）
    const existing = await this.prisma.subscription.findFirst({ where: { packageId } })
    if (existing) {
      throw new TenantConflictError('already subscribed to this package')
    }

    const result = await this.prisma.$transaction(async tx => {
      const sub = await tx.subscription.create({
        data: { enterpriseId: ctxTenant.enterpriseId, packageId, lockedPackageVersion: ver.version, status: 'ACTIVE' },
      })

      const employeeIds: number[] = []
      for (const item of ver.items) {
        const emp = await tx.siliconEmployee.create({
          data: {
            enterpriseId: ctxTenant.enterpriseId,
            subscriptionId: sub.id,
            templateSlug: item.templateSlug,
            templateVersion: item.templateVersion,
            displayName: item.templateSlug,
          },
        })
        // 默认 ENTERPRISE 层授权 全企业可用
        await tx.employeeGrant.create({
          data: {
            enterpriseId: ctxTenant.enterpriseId,
            employeeId: emp.id,
            scopeType: 'ENTERPRISE',
            scopeId: null,
            grantedBy: ctxTenant.memberId,
          },
        })
        employeeIds.push(emp.id)
      }
      return { sub, employeeIds }
    })

    await this.audit.write({
      action: 'SUBSCRIBE',
      targetType: 'Subscription',
      targetId: result.sub.id,
      after: { packageId, lockedPackageVersion: ver.version, employeeIds: result.employeeIds },
    })

    return result.sub
  }

  /** 本企业订阅列表（含员工与包信息） */
  async list() {
    return this.prisma.subscription.findMany({
      include: { employees: true, package: true },
      orderBy: { id: 'asc' },
    })
  }

  /**
   * 升级订阅：未 confirm 返回 diff 预览 confirm=true 才换锁版本与员工快照并写审计
   * @param subscriptionId 订阅 id
   * @param confirm 显式确认参数
   * @returns 预览（含 diff）或升级后的订阅
   */
  async upgrade(subscriptionId: number, confirm = false) {
    this.ctx.require()
    const sub = await this.prisma.subscription.findFirst({ where: { id: subscriptionId } })
    if (!sub) {
      throw new TenantNotFoundError('subscription not found')
    }

    const target = await this.packages.latestPublishedVersion(sub.packageId)
    if (!target) {
      throw new TenantInvalidStateError('package has no published version')
    }
    if (target.version === sub.lockedPackageVersion) {
      throw new TenantInvalidStateError('already on latest version')
    }

    // 读锁定的旧版本清单 与新版本对比
    const lockedVer = await this.prisma.packageVersion.findFirst({
      where: { packageId: sub.packageId, version: sub.lockedPackageVersion },
      include: { items: true },
    })
    const oldItems = (lockedVer?.items ?? []).map(i => ({ templateSlug: i.templateSlug, templateVersion: i.templateVersion }))
    const newItems = target.items.map(i => ({ templateSlug: i.templateSlug, templateVersion: i.templateVersion }))
    const diff = diffItems(oldItems, newItems)

    // 预览模式 不落库只返回差异
    if (!confirm) {
      return {
        preview: true,
        currentVersion: sub.lockedPackageVersion,
        targetVersion: target.version,
        diff,
      }
    }

    // confirm 执行：事务内换员工快照与锁版本
    await this.prisma.$transaction(async tx => {
      for (const item of newItems) {
        const existing = await tx.siliconEmployee.findFirst({
          where: { subscriptionId: sub.id, templateSlug: item.templateSlug },
        })
        if (existing) {
          await tx.siliconEmployee.update({ where: { id: existing.id }, data: { templateVersion: item.templateVersion } })
        } else {
          const emp = await tx.siliconEmployee.create({
            data: {
              enterpriseId: sub.enterpriseId,
              subscriptionId: sub.id,
              templateSlug: item.templateSlug,
              templateVersion: item.templateVersion,
              displayName: item.templateSlug,
            },
          })
          await tx.employeeGrant.create({
            data: { enterpriseId: sub.enterpriseId, employeeId: emp.id, scopeType: 'ENTERPRISE', scopeId: null, grantedBy: this.ctx.require().memberId },
          })
        }
      }

      // 清单中移除的模板 对应员工置 DISABLED 保留历史不删
      for (const removed of diff.removed) {
        await tx.siliconEmployee.updateMany({
          where: { subscriptionId: sub.id, templateSlug: removed.templateSlug, status: 'ACTIVE' },
          data: { status: 'DISABLED' },
        })
      }

      await tx.subscription.update({ where: { id: sub.id }, data: { lockedPackageVersion: target.version } })
    })

    await this.audit.write({
      action: 'UPGRADE',
      targetType: 'Subscription',
      targetId: sub.id,
      before: { lockedPackageVersion: sub.lockedPackageVersion, items: oldItems },
      after: { lockedPackageVersion: target.version, items: newItems },
      reason: `upgrade ${sub.lockedPackageVersion} -> ${target.version}`,
    })

    return this.prisma.subscription.findFirst({ where: { id: sub.id }, include: { employees: true } })
  }
}

/** 对比新旧清单项 按 slug 归组 分出新增/移除/变更 */
function diffItems(oldItems: ItemDiff['removed'], newItems: ItemDiff['added']): ItemDiff {
  const oldMap = new Map(oldItems.map(i => [i.templateSlug, i.templateVersion]))
  const newMap = new Map(newItems.map(i => [i.templateSlug, i.templateVersion]))

  const added = newItems.filter(i => !oldMap.has(i.templateSlug))
  const removed = oldItems.filter(i => !newMap.has(i.templateSlug))
  const changed = newItems.filter(i => oldMap.has(i.templateSlug) && oldMap.get(i.templateSlug) !== i.templateVersion)

  return { added, removed, changed }
}
