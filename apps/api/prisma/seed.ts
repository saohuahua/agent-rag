/**
 * 平台级种子：model_providers / model_routes / skills / 员工模板
 * 幂等（upsert / delete+create）可重复执行
 * 用法 node --env-file=../../.env --import tsx prisma/seed.ts
 * 注意：demo 企业（好物严选）的种子在 J 任务 prisma/demo-seed.ts
 */

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'
import { SkillType, TemplateStatus, ProviderKind } from '../src/generated/prisma/enums'

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

async function main() {
  await seedGateway()
  await seedSkills()
  await seedTemplates()

  // 汇总输出
  const [providers, routes, skills, templates] = await Promise.all([
    prisma.modelProvider.count(),
    prisma.modelRoute.count(),
    prisma.skill.count(),
    prisma.employeeTemplate.count(),
  ])
  console.log(`种子完成 providers=${providers} routes=${routes} skills=${skills} templates=${templates}`)
  await prisma.$disconnect()
}

main().catch(e => {
  console.error(`种子失败: ${e.message}`)
  process.exit(1)
})
