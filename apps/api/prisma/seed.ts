/**
 * 平台级种子：model_providers / model_routes / skills / 员工模板
 * 幂等（upsert / delete+create）可重复执行
 * 用法 node --env-file=../../.env --import tsx prisma/seed.ts
 * 注意：demo 企业（好物严选）的种子在 J 任务 prisma/demo-seed.ts
 */

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'
import { SkillType, TemplateStatus, ProviderKind, MemberRole, GrantScopeType, KbMode } from '../src/generated/prisma/enums'
import { hashPassword } from '../src/tenant/auth/password'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

/** 供应商与路由（价格 2026-09 官方页口径 标注 TODO 待实测账单核对） */
async function seedGateway() {
  await prisma.modelProvider.upsert({
    where: { name: 'deepseek' },
    update: {},
    create: {
      name: 'deepseek',
      kind: ProviderKind.LLM,
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
  })
  await prisma.modelProvider.upsert({
    where: { name: 'siliconflow' },
    update: {},
    create: {
      name: 'siliconflow',
      // siliconflow 同时提供 LLM 与 embedding kind 取 LLM 路由仍可用
      kind: ProviderKind.LLM,
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKeyEnv: 'SILICONFLOW_API_KEY',
    },
  })

  // 路由幂等：全删重建（种子数据 无业务价值）
  const ds = await prisma.modelProvider.findUniqueOrThrow({ where: { name: 'deepseek' } })
  const sf = await prisma.modelProvider.findUniqueOrThrow({ where: { name: 'siliconflow' } })
  await prisma.modelRoute.deleteMany({})
  await prisma.modelRoute.createMany({
    data: [
      // chat 主力链：deepseek-flash 优先 SiliconFlow Qwen3-8B 兜底
      // TODO(2026-10-08) 价格按实测账单核对 deepseek-flash 非高峰 ¥1/¥4
      { alias: 'chat', providerId: ds.id, upstreamModel: 'deepseek-flash', priority: 10, priceInPerMTok: 1, priceOutPerMTok: 4 },
      { alias: 'chat', providerId: sf.id, upstreamModel: 'Qwen/Qwen3-8B', priority: 20, priceInPerMTok: 0, priceOutPerMTok: 0.2 },
      // strong-chat 报告与关键决策
      { alias: 'strong-chat', providerId: ds.id, upstreamModel: 'deepseek-v4-pro', priority: 10, priceInPerMTok: 4.5, priceOutPerMTok: 13.5 },
      // embedding 检索向量（bge-m3 免费）
      { alias: 'embedding', providerId: sf.id, upstreamModel: 'BAAI/bge-m3', priority: 10, priceInPerMTok: 0, priceOutPerMTok: 0 },
    ],
  })
}

/** 技能台账（代码侧执行器在 src/skills/ H 任务实现） */
async function seedSkills() {
  const skills: Array<{
    key: string
    name: string
    type: SkillType
    riskLevel: number
    description: string
  }> = [
    { key: 'kb_search', name: '知识库检索', type: 'BUILTIN_FUNCTION', riskLevel: 1, description: '在企业知识库中检索与问题相关的原文片段 支持语义与关键词双路召回' },
    { key: 'compliance_check', name: '商品合规检查', type: 'BUILTIN_FUNCTION', riskLevel: 1, description: '对商品标题与描述做禁限售词与类目规则校验 输出结构化违规清单' },
    { key: 'batch_scan', name: '批量风险扫描', type: 'HTTP_RPA', riskLevel: 1, description: '批量调用检查接口扫描商品风险等级 适合店铺级巡检' },
    { key: 'ticket_classify', name: '工单分类', type: 'BUILTIN_FUNCTION', riskLevel: 1, description: '对售后工单文本分类 判断类型与紧急度并给出政策依据' },
    { key: 'operate_ticket', name: '工单操作', type: 'HTTP_RPA', riskLevel: 2, description: '在工单系统执行退款 拒绝 升级等写操作 属外部系统副作用' },
    { key: 'run_readonly_sql', name: '只读数据查询', type: 'BUILTIN_FUNCTION', riskLevel: 1, description: '对白名单业务表执行只读 SQL 查询 用于数据汇总与报表' },
    { key: 'consult_creative_agent', name: '创意外援', type: 'EXTERNAL_AGENT', riskLevel: 3, description: '咨询外部创意 agent 获取活动策划方案草案' },
  ]
  for (const s of skills) {
    await prisma.skill.upsert({
      where: { key: s.key },
      update: { name: s.name, type: s.type, riskLevel: s.riskLevel, description: s.description },
      create: s,
    })
  }
}

/** 六个数字员工模板（v1 直接 PUBLISHED 演示环境跳过审核流 审核流由 P4 管理页真实操作） */
async function seedTemplates() {
  const templates: Array<{
    slug: string
    version: number
    name: string
    description: string
    systemPrompt: string
  }> = [
    {
      slug: 'rule-qa', version: 1, name: '平台规则答疑客服',
      description: '回答电商平台规则与售后政策问题 引用知识库原文',
      systemPrompt: '你是电商平台规则答疑客服「小规」。只依据检索到的知识库片段回答问题 引用编号标注来源 资料未涉及时明确说无法回答。回答简洁 分点陈述。',
    },
    {
      slug: 'listing-auditor', version: 1, name: '商品上架审核员',
      description: '商品信息合规校验 输出结构化审核单',
      systemPrompt: '你是商品上架审核员「上架侠」。对商品标题 描述 类目做合规校验 调用 compliance_check 工具获取确定性结果 再补充风险提示 输出结构化审核单。',
    },
    {
      slug: 'risk-scanner', version: 1, name: '违规风险扫描员',
      description: '批量扫描店铺商品风险 出风险报告',
      systemPrompt: '你是违规风险扫描员「扫雷」。调用 batch_scan 工具扫描商品 汇总风险等级与建议 对高风险项给出处置优先级。',
    },
    {
      slug: 'ticket-agent', version: 1, name: '售后工单处理员',
      description: '工单分类 查政策 操作工单系统',
      systemPrompt: '你是售后工单处理员「售后侠」。先分类工单 再查售后政策依据 需要操作系统时调用 operate_ticket 工具 执行前向用户确认关键操作。',
    },
    {
      slug: 'report-analyst', version: 1, name: '数据周报分析员',
      description: '会话数据汇总出周报',
      systemPrompt: '你是数据周报分析员「周报姬」。用 run_readonly_sql 查询业务数据 汇总成周报 含关键指标变化与异常提示。',
    },
    {
      slug: 'campaign-assistant', version: 1, name: '活动策划助理',
      description: '活动方案创意与合规初筛',
      systemPrompt: '你是活动策划助理「点子」。先咨询外部创意 agent 获取方案草案 再用知识库做合规初筛 输出带风险标注的活动方案。',
    },
  ]
  for (const t of templates) {
    await prisma.employeeTemplate.upsert({
      where: { slug_version: { slug: t.slug, version: t.version } },
      update: { name: t.name, description: t.description, systemPrompt: t.systemPrompt },
      create: { ...t, status: TemplateStatus.PUBLISHED, createdBy: 0, publishedAt: new Date() },
    })
  }
}

// ==================== demo 种子：好物严选企业（J 任务） ====================
// 为什么放 seed.ts 而非独立文件：demo 依赖平台种子（模板/技能/供应商）且需同一次幂等重跑
// 边界遵守：本区块归 J 任务所有 平台种子区块归任务 0

/** demo 企业稳定标识 幂等 upsert 靠它 */
const DEMO_SLUG = 'haowu-yanxuan'

/** demo 所有者账号（供 web 登录演示 口令 demo123456） */
const DEMO_OWNER_EMAIL = 'owner@haowu.local'

/** demo 知识库数据集名 幂等 findFirst 靠它 */
const DEMO_DATASET_NAME = '规则知识库'

/** 六个数字员工：模板 slug → 展示名 顺序即上架顺序 */
const DEMO_EMPLOYEES: Array<{ templateSlug: string; displayName: string }> = [
  { templateSlug: 'rule-qa', displayName: '小规' },
  { templateSlug: 'listing-auditor', displayName: '上架侠' },
  { templateSlug: 'risk-scanner', displayName: '扫雷' },
  { templateSlug: 'ticket-agent', displayName: '售后侠' },
  { templateSlug: 'report-analyst', displayName: '周报姬' },
  { templateSlug: 'campaign-assistant', displayName: '点子' },
]

/** 按名字幂等建部门 返回已存在或新建行 */
async function ensureDept(enterpriseId: number, name: string, parentId: number | null): Promise<{ id: number; path: string }> {
  const existing = await prisma.department.findFirst({ where: { enterpriseId, name } })
  if (existing) return existing

  const parentPath = parentId
    ? (await prisma.department.findFirstOrThrow({ where: { id: parentId } })).path
    : ''

  // 事务内先建行拿自增 id 再回写物化路径（含自身 前后带斜杠）
  return prisma.$transaction(async tx => {
    const dept = await tx.department.create({
      data: { enterpriseId, name, parentId, path: '', sortOrder: 0 },
    })
    const path = parentId ? `${parentPath}${dept.id}/` : `/${dept.id}/`
    return tx.department.update({ where: { id: dept.id }, data: { path } })
  })
}

/** 按 slug 取模板 v1（平台种子已建 六个模板 v1 直接 PUBLISHED） */
async function templateOf(slug: string) {
  return prisma.employeeTemplate.findUniqueOrThrow({
    where: { slug_version: { slug, version: 1 } },
  })
}

/** 幂等重建某模板的技能与知识库绑定（先删后建 种子数据无业务价值） */
async function bindTemplate(
  templateId: number,
  datasetId: number,
  opts: {
    skillKeys?: string[]
    kbMode?: 'INJECT' | 'TOOL' | 'BOTH'
  },
): Promise<void> {
  await prisma.templateSkillBinding.deleteMany({ where: { templateId } })
  await prisma.templateKbBinding.deleteMany({ where: { templateId } })

  if (opts.skillKeys && opts.skillKeys.length > 0) {
    await prisma.templateSkillBinding.createMany({
      data: opts.skillKeys.map((skillKey, order) => ({ templateId, skillKey, order })),
    })
  }
  if (opts.kbMode) {
    await prisma.templateKbBinding.create({ data: { templateId, datasetId, kbMode: opts.kbMode } })
  }
}

/**
 * demo 企业种子：企业/部门/成员/订阅套装 v1/六员工/授权/知识库/模板绑定/订单样例
 * 幂等：企业与用户 upsert 其余按稳定键 findFirst 命中即跳过 绑定与订单先删后建
 */
async function seedDemoEnterprise(): Promise<void> {
  // 1 企业
  const enterprise = await prisma.enterprise.upsert({
    where: { slug: DEMO_SLUG },
    update: {},
    create: { name: '好物严选', slug: DEMO_SLUG, monthlyBudgetCny: 500 },
  })

  // 2 OWNER 用户与成员（供 web 登录）
  const owner = await prisma.user.upsert({
    where: { email: DEMO_OWNER_EMAIL },
    update: {},
    create: { email: DEMO_OWNER_EMAIL, passwordHash: hashPassword('demo123456'), displayName: '好物严选老板' },
  })
  const ownerMember = await prisma.member.upsert({
    where: { enterpriseId_userId: { enterpriseId: enterprise.id, userId: owner.id } },
    update: {},
    create: { enterpriseId: enterprise.id, userId: owner.id, role: MemberRole.OWNER, departmentId: null },
  })

  // 3 部门树：总部 → 客服中心 / 合规风控部 / 数据运营部
  const rootDept = await ensureDept(enterprise.id, '总部', null)
  const svcDept = await ensureDept(enterprise.id, '客服中心', rootDept.id)
  const complianceDept = await ensureDept(enterprise.id, '合规风控部', rootDept.id)
  const opsDept = await ensureDept(enterprise.id, '数据运营部', rootDept.id)

  // OWNER 成员补挂根部门（upsert 时 departmentId 为 null 这里回填）
  await prisma.member.update({ where: { id: ownerMember.id }, data: { departmentId: rootDept.id } })

  // 4 订阅套装 v1（电商智能员工套装 六岗位组合）
  const pkg = await prisma.subscriptionPackage.upsert({
    where: { slug: 'ecommerce-suite' },
    update: {},
    create: { slug: 'ecommerce-suite', name: '电商智能员工套装', description: '六岗位数字员工组合 覆盖答疑 审核 扫描 工单 周报 策划' },
  })
  const ver = await prisma.packageVersion.upsert({
    where: { packageId_version: { packageId: pkg.id, version: 1 } },
    update: {},
    create: { packageId: pkg.id, version: 1, status: TemplateStatus.PUBLISHED, publishedAt: new Date() },
  })
  await prisma.packageItem.deleteMany({ where: { packageVersionId: ver.id } })
  await prisma.packageItem.createMany({
    data: DEMO_EMPLOYEES.map(e => ({ packageVersionId: ver.id, templateSlug: e.templateSlug, templateVersion: 1 })),
  })

  // 5 订阅 锁 v1
  const sub = await prisma.subscription.upsert({
    where: { enterpriseId_packageId: { enterpriseId: enterprise.id, packageId: pkg.id } },
    update: {},
    create: { enterpriseId: enterprise.id, packageId: pkg.id, lockedPackageVersion: 1, status: 'ACTIVE' },
  })

  // 6 知识库数据集（规则知识库 供模板绑定与语料入库）
  const dataset = await prisma.knowledgeDataset.findFirst({
    where: { enterpriseId: enterprise.id, name: DEMO_DATASET_NAME },
  })
  const ds = dataset ?? await prisma.knowledgeDataset.create({
    data: { enterpriseId: enterprise.id, name: DEMO_DATASET_NAME, description: '好物严选平台规则与售后政策知识库' },
  })

  // 7 六员工 + 企业级授权
  for (const e of DEMO_EMPLOYEES) {
    const tpl = await templateOf(e.templateSlug)
    const emp = await prisma.siliconEmployee.findFirst({
      where: { enterpriseId: enterprise.id, displayName: e.displayName },
    })
    const employee = emp ?? await prisma.siliconEmployee.create({
      data: {
        enterpriseId: enterprise.id,
        subscriptionId: sub.id,
        templateSlug: tpl.slug,
        templateVersion: tpl.version,
        displayName: e.displayName,
        status: 'ACTIVE',
      },
    })

    const grant = await prisma.employeeGrant.findFirst({
      where: { enterpriseId: enterprise.id, employeeId: employee.id, scopeType: GrantScopeType.ENTERPRISE },
    })
    if (!grant) {
      await prisma.employeeGrant.create({
        data: {
          enterpriseId: enterprise.id,
          employeeId: employee.id,
          scopeType: GrantScopeType.ENTERPRISE,
          status: 'ACTIVE',
          grantedBy: ownerMember.id,
        },
      })
    }
  }

  // 8 模板绑定（技能 + 知识库）
  const [ruleQa, listingAuditor, riskScanner, ticketAgent, reportAnalyst, campaignAssistant] = await Promise.all([
    templateOf('rule-qa'),
    templateOf('listing-auditor'),
    templateOf('risk-scanner'),
    templateOf('ticket-agent'),
    templateOf('report-analyst'),
    templateOf('campaign-assistant'),
  ])

  await bindTemplate(ruleQa.id, ds.id, { skillKeys: ['kb_search'], kbMode: KbMode.INJECT })
  await bindTemplate(listingAuditor.id, ds.id, { skillKeys: ['compliance_check'] })
  await bindTemplate(riskScanner.id, ds.id, { skillKeys: ['batch_scan', 'compliance_check'] })
  await bindTemplate(ticketAgent.id, ds.id, { skillKeys: ['kb_search', 'ticket_classify', 'operate_ticket'], kbMode: KbMode.BOTH })
  await bindTemplate(reportAnalyst.id, ds.id, { skillKeys: ['run_readonly_sql'] })
  await bindTemplate(campaignAssistant.id, ds.id, { skillKeys: ['consult_creative_agent', 'kb_search'] })

  // 9 订单/商品/退款三张只读白名单表（run_readonly_sql 技能读它们 不在 Prisma schema 走 raw SQL）
  await seedDemoOrders(enterprise.id)

  console.log(`demo 种子完成 enterprise=${enterprise.name} id=${enterprise.id} datasetId=${ds.id}`)
}

/**
 * 订单/商品/退款三张只读白名单表（run_readonly_sql 技能的目标表）
 * 为什么 raw SQL 建表：这三张是技能白名单业务表 不进 Prisma schema（避免 schema 被技能反依赖污染）
 * 为什么带 enterprise_id：为多租户隔离预留 但 run_readonly_sql 技能当前不做注入 集成期已备案
 * 幂等：DROP+CREATE 保证重跑后结构一致（种子数据无业务价值 可整表重建）
 */
async function seedDemoOrders(enterpriseId: number): Promise<void> {
  await prisma.$executeRawUnsafe(`
    DROP TABLE IF EXISTS orders CASCADE;
    DROP TABLE IF EXISTS products CASCADE;
    DROP TABLE IF EXISTS refunds CASCADE;
    CREATE TABLE orders (
      id SERIAL PRIMARY KEY,
      enterprise_id INTEGER NOT NULL,
      order_no TEXT NOT NULL,
      product_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE products (
      id SERIAL PRIMARY KEY,
      enterprise_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      risk_level TEXT NOT NULL DEFAULT 'low'
    );
    CREATE TABLE refunds (
      id SERIAL PRIMARY KEY,
      enterprise_id INTEGER NOT NULL,
      order_no TEXT NOT NULL,
      refund_cents INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  // 示例订单 12 条 覆盖已付款/已发货/已完成/已退款 供周报姬汇总
  await prisma.$executeRawUnsafe(`
    INSERT INTO orders (enterprise_id, order_no, product_name, amount_cents, status, created_at) VALUES
      (${enterpriseId}, 'O202609280001', '玻尿酸补水面膜', 9900, 'PAID', now() - interval '2 day'),
      (${enterpriseId}, 'O202609280002', '烟酰胺美白精华液', 15900, 'SHIPPED', now() - interval '2 day'),
      (${enterpriseId}, 'O202609270015', '祛痘膏 温和型', 6900, 'COMPLETED', now() - interval '3 day'),
      (${enterpriseId}, 'O202609260033', '口红小样套装', 12900, 'COMPLETED', now() - interval '4 day'),
      (${enterpriseId}, 'O202609250021', '防晒霜 SPF50', 8900, 'REFUNDED', now() - interval '5 day'),
      (${enterpriseId}, 'O202609240077', '无线降噪耳机', 49900, 'COMPLETED', now() - interval '6 day'),
      (${enterpriseId}, 'O202609230055', '机械键盘 87 键', 26900, 'PAID', now() - interval '7 day'),
      (${enterpriseId}, 'O202609220101', '便携充电宝 20000mAh', 12900, 'SHIPPED', now() - interval '8 day'),
      (${enterpriseId}, 'O202609210088', '手机支架 桌面款', 3900, 'COMPLETED', now() - interval '9 day'),
      (${enterpriseId}, 'O202609200044', '纯棉 T 恤 白色', 5900, 'COMPLETED', now() - interval '10 day'),
      (${enterpriseId}, 'O202609190200', '牛仔外套 复古款', 18900, 'REFUNDED', now() - interval '11 day'),
      (${enterpriseId}, 'O202609180033', '每日坚果 30 包', 9900, 'COMPLETED', now() - interval '12 day')
  `)

  await prisma.$executeRawUnsafe(`
    INSERT INTO products (enterprise_id, name, category, price_cents, risk_level) VALUES
      (${enterpriseId}, '玻尿酸补水面膜 全网最低价', '化妆品', 9900, 'high'),
      (${enterpriseId}, '烟酰胺美白精华液', '化妆品', 15900, 'medium'),
      (${enterpriseId}, '100%有效的祛痘膏', '化妆品', 6900, 'high'),
      (${enterpriseId}, '防晒霜 国家级检测认证', '化妆品', 8900, 'high'),
      (${enterpriseId}, '无线降噪耳机 行业第一', '数码', 49900, 'high'),
      (${enterpriseId}, '机械键盘 87 键', '数码', 26900, 'low'),
      (${enterpriseId}, '纯棉 T 恤 白色', '服饰', 5900, 'low'),
      (${enterpriseId}, '每日坚果 30 包', '食品', 9900, 'low')
  `)

  await prisma.$executeRawUnsafe(`
    INSERT INTO refunds (enterprise_id, order_no, refund_cents, reason, created_at) VALUES
      (${enterpriseId}, 'O202609250021', 8900, '七天无理由退货', now() - interval '5 day'),
      (${enterpriseId}, 'O202609190200', 18900, '尺码不符', now() - interval '11 day')
  `)
}

async function main() {
  await seedGateway()
  await seedSkills()
  await seedTemplates()
  await seedDemoEnterprise()

  // 汇总输出
  const [providers, routes, skills, templates, enterprises, employees] = await Promise.all([
    prisma.modelProvider.count(),
    prisma.modelRoute.count(),
    prisma.skill.count(),
    prisma.employeeTemplate.count(),
    prisma.enterprise.count(),
    prisma.siliconEmployee.count(),
  ])
  console.log(`种子完成 providers=${providers} routes=${routes} skills=${skills} templates=${templates} enterprises=${enterprises} employees=${employees}`)
  await prisma.$disconnect()
}

main().catch(e => {
  console.error(`种子失败: ${e.message}`)
  process.exit(1)
})
