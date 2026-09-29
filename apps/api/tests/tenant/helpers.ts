import * as fs from 'node:fs'
import * as path from 'node:path'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../src/generated/prisma/client'
import { tenantExtension } from '../../src/tenant/prisma-tenant.extension'
import { EnterpriseContextService } from '../../src/tenant/enterprise-context.service'
import type { PrismaService } from '../../src/prisma/prisma.service'
import type { TenantCtx } from '@agent-rag/shared'

/**
 * 测试辅助：加载根 .env（DATABASE_URL）复刻 env.service 的极简解析 不引 dotenv
 */
function loadEnv(file: string): void {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || !m[1]) continue
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}
loadEnv(path.resolve(process.cwd(), '../../.env'))
loadEnv(path.resolve(process.cwd(), '.env'))

/** 构造带租户扩展的客户端（等价 prisma.service.ts 的 3 行挂载补丁） */
export function createTenantPrisma() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const base = new PrismaClient({ adapter })
  return base.$extends(tenantExtension) as unknown as PrismaService
}

/** 全新上下文服务实例（单测无 DI 直接 new） */
export const makeCtxService = () => new EnterpriseContextService()

/** 构造租户上下文 */
export function ctxOf(enterpriseId: number, memberId: number, role: TenantCtx['role'] = 'OWNER'): TenantCtx {
  return { enterpriseId, memberId, role }
}

/** 完整租户夹具：企业 + 用户 + 根部门 + OWNER 成员 */
export async function createTenant(prisma: PrismaService, name: string) {
  const slug = `test-${name.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 100000)}`
  const user = await prisma.user.create({ data: { email: `${slug}@test.local`, passwordHash: 'x', displayName: name } })
  const enterprise = await prisma.enterprise.create({ data: { name, slug } })
  const dept = await prisma.department.create({ data: { enterpriseId: enterprise.id, name: '总部', path: `/${enterprise.id}/` } })
  const member = await prisma.member.create({
    data: { enterpriseId: enterprise.id, userId: user.id, role: 'OWNER', departmentId: dept.id },
  })
  return { user, enterprise, dept, member, ctx: ctxOf(enterprise.id, member.id) }
}

/** 按 FK 依赖逆序清理租户全部数据（无上下文直通 不触发扩展过滤） */
export async function teardownTenant(prisma: PrismaService, tenant: Awaited<ReturnType<typeof createTenant>>): Promise<void> {
  const eid = tenant.enterprise.id

  await prisma.employeeGrant.deleteMany({ where: { enterpriseId: eid } })
  await prisma.siliconEmployee.deleteMany({ where: { enterpriseId: eid } })
  await prisma.subscription.deleteMany({ where: { enterpriseId: eid } })
  // 会话删除级联 participant/message/event
  await prisma.conversationSession.deleteMany({ where: { enterpriseId: eid } })
  // 文档删除级联 chunk
  await prisma.knowledgeDoc.deleteMany({ where: { enterpriseId: eid } })
  await prisma.knowledgeDataset.deleteMany({ where: { enterpriseId: eid } })
  await prisma.member.deleteMany({ where: { enterpriseId: eid } })
  await prisma.invitation.deleteMany({ where: { enterpriseId: eid } })

  // 部门自引用 FK 按 path 倒序（叶子先删）
  const depts = await prisma.department.findMany({ where: { enterpriseId: eid }, orderBy: { path: 'desc' } })
  for (const d of depts) {
    await prisma.department.delete({ where: { id: d.id } })
  }

  await prisma.user.deleteMany({ where: { id: tenant.user.id } })
  await prisma.enterprise.delete({ where: { id: eid } })
}
