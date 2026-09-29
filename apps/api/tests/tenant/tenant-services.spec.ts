import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenant, createTenantPrisma, makeCtxService, teardownTenant } from './helpers'
import { EnterpriseContextService } from '../../src/tenant/enterprise-context.service'
import { AuditService } from '../../src/tenant/audit.service'
import { TemplateService } from '../../src/tenant/template/template.service'
import { PackageService } from '../../src/tenant/package/package.service'
import { SubscriptionService } from '../../src/tenant/subscription.service'
import { GrantService } from '../../src/tenant/grant.service'
import { DepartmentService } from '../../src/tenant/department.service'
import { TenantInvalidStateError } from '../../src/tenant/tenant.errors'
import type { PrismaService } from '../../src/prisma/prisma.service'

/**
 * 租户领域服务集成测试（真实 PGlite）
 * 覆盖：模板状态机 / 订阅锁版本与升级 diff / 授权三层解析 / 部门物化路径树
 * 验收 §4.9 的「审核→订阅锁 v1→发 v2→老订阅不动→confirm 升级→AuditLog before/after」全流程
 */
describe('租户领域服务', () => {
  let prisma: PrismaService
  let svc: EnterpriseContextService
  let audit: AuditService
  let templates: TemplateService
  let packages: PackageService
  let subs: SubscriptionService
  let grants: GrantService
  let depts: DepartmentService

  let tenantA: Awaited<ReturnType<typeof createTenant>>

  // 平台级产物 供清理
  const slugs: string[] = []
  let pkgId = 0
  const verIds: number[] = []

  // 订阅流程产物
  let packageId = 0
  let subscriptionId = 0
  let employeeId = 0
  let tplSlug = ''

  beforeAll(async () => {
    prisma = createTenantPrisma()
    svc = makeCtxService()
    audit = new AuditService(prisma, svc)
    templates = new TemplateService(prisma, svc, audit)
    packages = new PackageService(prisma, svc, audit)
    subs = new SubscriptionService(prisma, svc, audit, packages)
    grants = new GrantService(prisma, svc, audit)
    depts = new DepartmentService(prisma, svc)

    tenantA = await createTenant(prisma, '服务测试企业')
    tplSlug = `svc-qa-${Date.now()}`
    slugs.push(tplSlug)

    // 模板审核上架 v1
    await svc.run(tenantA.ctx, async () => {
      const draft = await templates.draft({ slug: tplSlug, name: '服务测试客服', systemPrompt: 'v1' })
      await templates.submit(draft.id)
      await templates.publish(draft.id)
    })

    // 包 + 已发布 v1（含该模板 v1）
    await svc.run(tenantA.ctx, async () => {
      const pkg = await packages.create({ slug: `svc-pkg-${Date.now()}`, name: '服务测试包' })
      packageId = pkg.id
      pkgId = pkg.id
      const ver = await packages.createVersion(pkg.id, [{ templateSlug: tplSlug, templateVersion: 1 }])
      verIds.push(ver.id)
      await packages.submitVersion(ver.id)
      await packages.publishVersion(ver.id)

      // 订阅 锁 v1
      const sub = await subs.create(pkg.id)
      subscriptionId = sub.id
      const emps = await prisma.siliconEmployee.findMany({ where: { subscriptionId: sub.id } })
      employeeId = emps[0]!.id
    })
  })

  afterAll(async () => {
    if (prisma) {
      if (tenantA) await teardownTenant(prisma, tenantA)
      await prisma.packageItem.deleteMany({ where: { packageVersionId: { in: verIds } } })
      await prisma.packageVersion.deleteMany({ where: { id: { in: verIds } } })
      if (pkgId) await prisma.subscriptionPackage.deleteMany({ where: { id: pkgId } })
      if (slugs.length) await prisma.employeeTemplate.deleteMany({ where: { slug: { in: slugs } } })
      await prisma.$disconnect()
    }
  })

  describe('模板状态机', () => {
    it('DRAFT → 提交 → 发布 且 PUBLISHED 不可 UPDATE', async () => {
      const slug = `tmpl-immutable-${Date.now()}`
      slugs.push(slug)
      await svc.run(tenantA.ctx, async () => {
        const draft = await templates.draft({ slug, name: '不可变模板', systemPrompt: 'x' })
        expect(draft.status).toBe('DRAFT')

        await templates.submit(draft.id)
        await templates.publish(draft.id)
        const published = await prisma.employeeTemplate.findFirst({ where: { id: draft.id } })
        expect(published!.status).toBe('PUBLISHED')
        expect(published!.publishedAt).not.toBeNull()

        // PUBLISHED 编辑与绑定都拒绝（新行为=新版本行）
        await expect(templates.update(draft.id, { name: '改名' })).rejects.toThrow(TenantInvalidStateError)
        await expect(templates.setBindings(draft.id, { kbBindings: [{ datasetId: 1, kbMode: 'INJECT' }] })).rejects.toThrow(TenantInvalidStateError)

        // 同 slug 再起草开 v2
        const v2 = await templates.draft({ slug })
        expect(v2.version).toBe(2)
        expect(v2.status).toBe('DRAFT')
      })
    })

    it('REJECTED 可编辑后再提交', async () => {
      const slug = `tmpl-reject-${Date.now()}`
      slugs.push(slug)
      await svc.run(tenantA.ctx, async () => {
        const draft = await templates.draft({ slug, name: '驳回模板', systemPrompt: 'x' })
        await templates.submit(draft.id)
        await templates.reject(draft.id, '不合规')

        const rejected = await prisma.employeeTemplate.findFirst({ where: { id: draft.id } })
        expect(rejected!.status).toBe('REJECTED')
        expect(rejected!.reviewNote).toBe('不合规')

        // 驳回后可编辑并重新提交
        await templates.update(draft.id, { systemPrompt: '改好了' })
        const again = await templates.submit(draft.id)
        expect(again.status).toBe('PENDING_REVIEW')
      })
    })
  })

  describe('订阅锁版本与升级', () => {
    it('发 v2 后老订阅仍锁 v1 升级预览返回 diff', async () => {
      await svc.run(tenantA.ctx, async () => {
        // 发包 v2（模板 v2）
        const v2 = await packages.createVersion(packageId, [{ templateSlug: tplSlug, templateVersion: 2 }])
        verIds.push(v2.id)
        await packages.submitVersion(v2.id)
        await packages.publishVersion(v2.id)

        // 老订阅不动 仍锁 v1 员工快照仍 v1
        const sub = await prisma.subscription.findFirst({ where: { id: subscriptionId } })
        expect(sub!.lockedPackageVersion).toBe(1)
        const emp = await prisma.siliconEmployee.findFirst({ where: { id: employeeId } })
        expect(emp!.templateVersion).toBe(1)

        // 预览升级 不落库
        const preview = await subs.upgrade(subscriptionId, false) as {
          preview: boolean
          currentVersion: number
          targetVersion: number
          diff: { changed: Array<{ templateSlug: string; templateVersion: number }> }
        }
        expect(preview.preview).toBe(true)
        expect(preview.currentVersion).toBe(1)
        expect(preview.targetVersion).toBe(2)
        expect(preview.diff.changed).toEqual([{ templateSlug: tplSlug, templateVersion: 2 }])

        // 预览后仍锁 v1
        const afterPreview = await prisma.subscription.findFirst({ where: { id: subscriptionId } })
        expect(afterPreview!.lockedPackageVersion).toBe(1)
      })
    })

    it('confirm 升级换锁版本与员工快照 且 AuditLog 有 before/after', async () => {
      await svc.run(tenantA.ctx, async () => {
        const upgraded = await subs.upgrade(subscriptionId, true) as { lockedPackageVersion: number }
        expect(upgraded.lockedPackageVersion).toBe(2)

        const emp = await prisma.siliconEmployee.findFirst({ where: { id: employeeId } })
        expect(emp!.templateVersion).toBe(2)

        // 审计 before/after 留证
        const log = await prisma.auditLog.findFirst({
          where: { action: 'UPGRADE', targetType: 'Subscription', targetId: subscriptionId, enterpriseId: tenantA.enterprise.id },
          orderBy: { id: 'desc' },
        })
        expect(log).not.toBeNull()
        const before = log!.beforeJson as { lockedPackageVersion: number; items: unknown[] }
        const after = log!.afterJson as { lockedPackageVersion: number; items: unknown[] }
        expect(before.lockedPackageVersion).toBe(1)
        expect(after.lockedPackageVersion).toBe(2)
      })
    })
  })

  describe('授权三层解析', () => {
    let childDeptId = 0
    let grandDeptId = 0
    let rootMemberId = 0
    let childMemberId = 0
    let grandMemberId = 0

    beforeAll(async () => {
      await svc.run(tenantA.ctx, async () => {
        // 部门子树：总部 → 客服部 → 售前组
        const child = await depts.create('客服部', tenantA.dept.id)
        childDeptId = child.id
        const grand = await depts.create('售前组', child.id)
        grandDeptId = grand.id
        rootMemberId = tenantA.member.id

        // 在客服部与售前组各造一个成员
        const u2 = await prisma.user.create({ data: { email: `child-${Date.now()}@test.local`, passwordHash: 'x', displayName: '客服员' } })
        const m2 = await prisma.member.create({ data: { enterpriseId: tenantA.enterprise.id, userId: u2.id, role: 'MEMBER', departmentId: childDeptId } })
        childMemberId = m2.id

        const u3 = await prisma.user.create({ data: { email: `grand-${Date.now()}@test.local`, passwordHash: 'x', displayName: '售前员' } })
        const m3 = await prisma.member.create({ data: { enterpriseId: tenantA.enterprise.id, userId: u3.id, role: 'MEMBER', departmentId: grandDeptId } })
        grandMemberId = m3.id
      })
    })

    it('ENTERPRISE 授权同企业任何成员可用', async () => {
      await svc.run(tenantA.ctx, async () => {
        expect(await grants.canUse(grandMemberId, employeeId)).toBe(true)
      })
    })

    it('DEPARTMENT 授权命中子树 孙部门成员可用 根成员不可用', async () => {
      await svc.run(tenantA.ctx, async () => {
        // 撤销默认企业授权
        await prisma.employeeGrant.updateMany({ where: { employeeId, scopeType: 'ENTERPRISE', status: 'ACTIVE' }, data: { status: 'REVOKED' } })
        expect(await grants.canUse(rootMemberId, employeeId)).toBe(false)

        // 授给客服部（含子树）
        await grants.create(employeeId, 'DEPARTMENT', childDeptId)
        expect(await grants.canUse(childMemberId, employeeId)).toBe(true)
        expect(await grants.canUse(grandMemberId, employeeId)).toBe(true)
        expect(await grants.canUse(rootMemberId, employeeId)).toBe(false)
      })
    })

    it('MEMBER 授权仅命中指定成员', async () => {
      await svc.run(tenantA.ctx, async () => {
        await prisma.employeeGrant.updateMany({ where: { employeeId, scopeType: 'DEPARTMENT', status: 'ACTIVE' }, data: { status: 'REVOKED' } })
        expect(await grants.canUse(grandMemberId, employeeId)).toBe(false)

        await grants.create(employeeId, 'MEMBER', childMemberId)
        expect(await grants.canUse(childMemberId, employeeId)).toBe(true)
        expect(await grants.canUse(grandMemberId, employeeId)).toBe(false)
      })
    })
  })

  describe('部门物化路径树', () => {
    it('子树嵌套与路径正确 改名不动路径 非空删除拒绝', async () => {
      await svc.run(tenantA.ctx, async () => {
        const child = await depts.create('售后部', tenantA.dept.id)
        expect(child.path).toBe(`${tenantA.dept.path}${child.id}/`)
        const grand = await depts.create('售后一组', child.id)
        expect(grand.path).toBe(`${child.path}${grand.id}/`)

        // 树结构：根下含售后部
        const tree = await depts.tree()
        const root = tree.find(n => n.id === tenantA.dept.id)
        expect(root).toBeDefined()
        expect(root!.children.map(c => c.name)).toContain('售后部')

        // 改名 path 不变
        const renamed = await depts.rename(child.id, '售后部改名')
        expect(renamed.path).toBe(child.path)

        // 非空删除拒绝（有子部门）
        await expect(depts.remove(child.id)).rejects.toThrow()
      })
    })
  })
})
