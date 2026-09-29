import { Prisma } from '../generated/prisma/client'
import { tenantStorage } from './enterprise-context.service'

/**
 * 租户过滤扩展（产出物 挂载补丁见报告 docs/08-阶段总结/D-多租户-报告.md）
 * 为什么用 Client Extension 而不用 $use：$use 是官方弃用方向 Extension 是正路（规格 §3）
 * 为什么不用 Postgres RLS：driver adapter 连接池下 SET app.tenant 会话管理复杂 ORM+raw 双轨更易漏
 *   本方案用「扩展收口 + 测试矩阵」兜底 个人项目成本最合算（规格 §3 讲得出取舍）
 *
 * 关键机制：Prisma 7 的模型方法是延迟执行的 thenable 只有 await 发生在 ALS 上下文内
 *   扩展回调才拿得到 store 因此调用方必须用 EnterpriseContextService.run(ctx, async () => { await prisma... })
 *   请求链路由 tenant-context.interceptor 在订阅 handler 前进入 ALS 保证（见该文件 why）
 *
 * 行为：无上下文时直通（auth 注册/登录/种子脚本合法无租户）有上下文时对租户模型强制注入隔离条件
 * 覆盖 12 张租户表的其中 10 张硬过滤 + 2 张横切表（usage_records/audit_logs 企业 id 可空）由各自服务显式收口
 */
export const tenantExtension = Prisma.defineExtension({
  query: {
    $allModels: {
      async $allOperations(params) {
        const { model, operation, args, query } = params
        const ctx = tenantStorage.getStore()?.ctx ?? null

        // 无租户上下文 直通（平台级动作与认证流）
        if (!ctx) return query(args)

        // model 是 PascalCase 模型名（如 KnowledgeDataset）查表命中才处理
        const scopeField = model ? TENANT_SCOPE[model] : undefined
        if (!scopeField) return query(args)

        return query(injectScope(operation, args, scopeField, ctx.enterpriseId))
      },
    },
  },
})

/**
 * 12 张租户表的硬编码清单（模型名 PascalCase → 隔离字段）
 * 10 张在这里硬过滤 另 2 张横切表（usage_records/audit_logs）enterpriseId 可空 属平台级 由服务显式收口
 * Enterprise 是租户根 隔离字段是自身 id（只能看到本企业）
 */
const TENANT_SCOPE: Record<string, 'enterpriseId' | 'id'> = {
  Enterprise: 'id',
  Department: 'enterpriseId',
  Member: 'enterpriseId',
  Invitation: 'enterpriseId',
  Subscription: 'enterpriseId',
  SiliconEmployee: 'enterpriseId',
  EmployeeGrant: 'enterpriseId',
  ConversationSession: 'enterpriseId',
  KnowledgeDataset: 'enterpriseId',
  KnowledgeDoc: 'enterpriseId',
}

/**
 * 按操作类型给 args 注入隔离字段 返回新对象不污染调用方入参
 * findUnique/upsert 的 where 是 unique 输入 注入非唯一字段时 Prisma 会校验拒绝（fail-closed 不泄漏）
 * 因此业务代码对租户模型一律用 findFirst/findFirstOrThrow 绕开 unique 限制（规格 §4.3）
 * @param operation Prisma 操作名（camelCase）
 * @param args 原始查询参数（Prisma 类型为 any 这里收窄为 Record 便于安全访问）
 * @param scopeField 注入到哪个字段
 * @param enterpriseId 当前租户 id
 */
function injectScope(
  operation: string,
  args: Record<string, unknown>,
  scopeField: 'enterpriseId' | 'id',
  enterpriseId: number,
): Record<string, unknown> {
  // create 类：只有带 enterpriseId 字段的模型才注入（Enterprise 根没有该字段 跳过）
  if (operation === 'create') {
    if (scopeField !== 'enterpriseId') return args
    return { ...args, data: { ...asRecord(args.data), enterpriseId } }
  }

  if (operation === 'createMany' || operation === 'createManyAndReturn') {
    if (scopeField !== 'enterpriseId') return args
    const list = Array.isArray(args.data) ? args.data : []
    return { ...args, data: list.map(d => ({ ...asRecord(d), enterpriseId })) }
  }

  if (operation === 'upsert') {
    // create 分支注入 空 update 分支保持原样 where 分支注入（可能因 unique 校验拒绝 属 fail-closed）
    const create = scopeField === 'enterpriseId' ? { ...asRecord(args.create), enterpriseId } : args.create
    return { ...args, create, where: { ...asRecord(args.where), [scopeField]: enterpriseId } }
  }

  // where 类：findMany/findFirst/count/aggregate/groupBy/update/updateMany/delete/deleteMany/findUnique
  // Enterprise 根按自身 id 隔离 用 AND 追加而非覆盖 否则调用方按 id 查别企业会被覆盖成自己误命中
  if (scopeField === 'id') {
    return { ...args, where: { ...asRecord(args.where), AND: [{ id: enterpriseId }] } }
  }
  return { ...args, where: { ...asRecord(args.where), [scopeField]: enterpriseId } }
}

/** 把 unknown 收窄为 Record 空对象兜底（Prisma args 为 any 此处安全转） */
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}
