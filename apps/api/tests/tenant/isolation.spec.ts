import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenant, createTenantPrisma, makeCtxService, teardownTenant } from './helpers'
import { AuditService } from '../../src/tenant/audit.service'
import { EnterpriseContextService } from '../../src/tenant/enterprise-context.service'
import type { PrismaService } from '../../src/prisma/prisma.service'

/**
 * 租户隔离矩阵（验收核心 §4.8）：租户 A 造数 → 租户 B 上下文查全部租户模型 → 断言 0 行/不可见
 * 覆盖 12 张租户表：10 张扩展硬过滤（Enterprise 按 id 其余按 enterpriseId）
 *   + AuditLog（服务显式按企业过滤）+ UsageRecord（平台级 由任务 A 网关写入覆盖 本文档备案）
 */
describe('租户隔离矩阵：A 造数 B 不可见', () => {
  let prisma: PrismaService
  let svc: EnterpriseContextService
  let audit: AuditService
  let tenantA: Awaited<ReturnType<typeof createTenant>>
  let tenantB: Awaited<ReturnType<typeof createTenant>>
  let pkgId = 0
  let verId = 0

  // A 租户各模型行的 id 供 B 侧断言不可见
  let aDatasetId = 0
  let aDocId = 0
  let aSessionId = 0
  let aSubId = 0
  let aEmpId = 0
  let aGrantId = 0
  let aInviteId = 0
  let aAuditId = 0

  beforeAll(async () => {
    prisma = createTenantPrisma()
    svc = makeCtxService()
    audit = new AuditService(prisma, svc)

    tenantA = await createTenant(prisma, '甲企业')
    tenantB = await createTenant(prisma, '乙企业')

    // 平台级包 + 已发布版本 + 清单项（订阅前置依赖 平台共享）
    const pkg = await prisma.subscriptionPackage.create({
      data: { slug: `iso-pkg-${Date.now()}`, name: '隔离测试包', description: '' },
    })
    pkgId = pkg.id
    const ver = await prisma.packageVersion.create({
      data: { packageId: pkg.id, version: 1, status: 'PUBLISHED', publishedAt: new Date() },
    })
    verId = ver.id
    await prisma.packageItem.create({ data: { packageVersionId: ver.id, templateSlug: 'rule-qa', templateVersion: 1 } })

    // A 租户在自身上下文内造数 显式带 enterpriseId（扩展会再注入同值 双保险）
    await svc.run(tenantA.ctx, async () => {
      const ds = await prisma.knowledgeDataset.create({ data: { enterpriseId: tenantA.enterprise.id, name: 'A 知识库' } })
      aDatasetId = ds.id

      const doc = await prisma.knowledgeDoc.create({
        data: {
          datasetId: ds.id,
          enterpriseId: tenantA.enterprise.id,
          title: 'A 文档',
          sourceType: 'UPLOAD',
          storageKey: 'iso/a.md',
          mimeType: 'text/plain',
          sizeBytes: 10,
          checksum: `iso-a-${Date.now()}`,
          status: 'INDEXED',
          uploadedBy: tenantA.member.id,
        },
      })
      aDocId = doc.id

      const session = await prisma.conversationSession.create({ data: { enterpriseId: tenantA.enterprise.id, status: 'ACTIVE' } })
      aSessionId = session.id

      const sub = await prisma.subscription.create({ data: { enterpriseId: tenantA.enterprise.id, packageId: pkgId, lockedPackageVersion: 1, status: 'ACTIVE' } })
      aSubId = sub.id

      const emp = await prisma.siliconEmployee.create({
        data: { enterpriseId: tenantA.enterprise.id, subscriptionId: sub.id, templateSlug: 'rule-qa', templateVersion: 1, displayName: 'A 员工' },
      })
      aEmpId = emp.id

      const grant = await prisma.employeeGrant.create({ data: { enterpriseId: tenantA.enterprise.id, employeeId: emp.id, scopeType: 'ENTERPRISE', grantedBy: tenantA.member.id } })
      aGrantId = grant.id

      const inv = await prisma.invitation.create({
        data: { enterpriseId: tenantA.enterprise.id, email: 'a@test.local', token: `iso-token-a-${Date.now()}`, expiresAt: new Date(Date.now() + 3600_000) },
      })
      aInviteId = inv.id

      await audit.write({ action: 'SUBSCRIBE', targetType: 'Subscription', targetId: sub.id, after: { v: 1 } })
      const aAudit = await prisma.auditLog.findFirst({ where: { enterpriseId: tenantA.enterprise.id, action: 'SUBSCRIBE' }, orderBy: { id: 'desc' } })
      aAuditId = aAudit!.id
    })
  })

  afterAll(async () => {
    if (prisma) {
      if (tenantA) await teardownTenant(prisma, tenantA)
      if (tenantB) await teardownTenant(prisma, tenantB)
      if (verId) await prisma.packageItem.deleteMany({ where: { packageVersionId: verId } })
      if (verId) await prisma.packageVersion.deleteMany({ where: { id: verId } })
      if (pkgId) await prisma.subscriptionPackage.deleteMany({ where: { id: pkgId } })
      await prisma.$disconnect()
    }
  })

  it('B 上下文查 A 的 10 张硬过滤表全部 0 行/不可见', async () => {
    await svc.run(tenantB.ctx, async () => {
      // Enterprise 根：B 只能看到自己 看不到 A
      const enterprises = await prisma.enterprise.findMany()
      expect(enterprises.map(e => e.id)).not.toContain(tenantA.enterprise.id)
      expect(await prisma.enterprise.findFirst({ where: { id: tenantA.enterprise.id } })).toBeNull()

      expect(await prisma.department.findFirst({ where: { id: tenantA.dept.id } })).toBeNull()
      expect(await prisma.member.findFirst({ where: { id: tenantA.member.id } })).toBeNull()
      expect(await prisma.invitation.findFirst({ where: { id: aInviteId } })).toBeNull()
      expect(await prisma.subscription.findFirst({ where: { id: aSubId } })).toBeNull()
      expect(await prisma.siliconEmployee.findFirst({ where: { id: aEmpId } })).toBeNull()
      expect(await prisma.employeeGrant.findFirst({ where: { id: aGrantId } })).toBeNull()
      expect(await prisma.conversationSession.findFirst({ where: { id: aSessionId } })).toBeNull()
      expect(await prisma.knowledgeDataset.findFirst({ where: { id: aDatasetId } })).toBeNull()
      expect(await prisma.knowledgeDoc.findFirst({ where: { id: aDocId } })).toBeNull()

      // findMany 兜底：B 自己的列表不含 A 的行
      expect(await prisma.knowledgeDataset.findMany()).toEqual([])
      expect(await prisma.knowledgeDoc.findMany()).toEqual([])
      expect(await prisma.conversationSession.findMany()).toEqual([])
      expect(await prisma.subscription.findMany()).toEqual([])
      expect(await prisma.siliconEmployee.findMany()).toEqual([])
      expect(await prisma.employeeGrant.findMany()).toEqual([])
      expect(await prisma.invitation.findMany()).toEqual([])
    })
  })

  it('B 上下文查 AuditLog 看不到 A 的审计（服务显式按企业过滤）', async () => {
    await svc.run(tenantB.ctx, async () => {
      const list = await audit.list({})
      const ids = list.map(r => (r as { id: number }).id)
      expect(ids).not.toContain(aAuditId)
    })
  })

  it('无上下文直通（平台模式）能看到 A 与 B 的数据', async () => {
    // 无 ALS 上下文 扩展不注入 用于认证流与种子脚本的合法旁路
    const datasets = await prisma.knowledgeDataset.findMany()
    expect(datasets.map(d => d.enterpriseId)).toEqual(expect.arrayContaining([tenantA.enterprise.id]))
  })

  it('create 注入 enterpriseId：扩展覆盖调用方传入的错误企业字段', async () => {
    // 故意传 -1 扩展应覆盖为当前上下文企业 证明 create 注入强制生效
    const created = await svc.run(tenantA.ctx, async () => prisma.knowledgeDataset.create({ data: { enterpriseId: -1, name: 'A 注入验证' } }))
    expect(created.enterpriseId).toBe(tenantA.enterprise.id)
    await prisma.knowledgeDataset.deleteMany({ where: { id: created.id } })
  })
})
