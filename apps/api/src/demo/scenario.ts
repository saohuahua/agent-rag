import * as path from 'node:path'
import { ingestCorpus } from './corpus-ingest'
import { buildDemoServices } from './bootstrap'
import type { PrismaService } from '../prisma/prisma.service'
import type { GatewayService } from '../gateway/gateway.service'
import type { RetrievalService } from '../rag/retrieval.service'
import type { SkillExecutorRegistry } from '../skills/skill-executor'
import type { SessionService } from '../runtime/session.service'
import type { TurnProcessor } from '../runtime/turn.processor'
import type { EventsService } from '../runtime/events.service'
import type { TenantCtx } from '@agent-rag/shared'

/** 仓库根 */
const REPO_ROOT = path.resolve(process.cwd(), '../..')

/** 断言失败异常 */
class ScenarioError extends Error {
  readonly code = 'SCENARIO_ASSERT'

  constructor(msg: string) {
    super(msg)
    this.name = 'ScenarioError'
  }
}

/** 轻量断言 失败抛 ScenarioError */
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new ScenarioError(msg)
  console.log(`  ✓ ${msg}`)
}

/** 场景运行上下文 把依赖聚合一处 */
interface ScenarioCtx {
  prisma: PrismaService
  gateway: GatewayService
  retrieval: RetrievalService
  registry: SkillExecutorRegistry
  sessions: SessionService
  turns: TurnProcessor
  events: EventsService
  enterpriseId: number
  memberId: number
  tenantCtx: TenantCtx
}

/** 构建技能执行上下文（直接调用技能自检用） */
function skillCtx(sessionId: number, employeeId: number, templateSlug: string, tenantCtx: TenantCtx) {
  return {
    sessionId,
    employeeId,
    templateSlug,
    configJson: null,
    ctx: tenantCtx,
    emit: async () => {},
  }
}

/**
 * 技能自检：不经过 LLM 直接调执行器 确定性证明三类能力可用
 * 为什么放在 LLM 回合之前：先把确定性能力证死 后续 LLM 回合即使偶发不调用工具 核心证据也不塌
 */
async function skillSelfChecks(c: ScenarioCtx, employees: Record<string, number>): Promise<void> {
  console.log('\n[1] 技能自检（确定性 不经 LLM）')

  // kb_search：查七天无理由 应命中语料
  const kb = await c.registry.execute({
    skillKey: 'kb_search',
    input: { query: '七天无理由退货从哪天起算', topK: 3 },
    skillCtx: skillCtx(0, employees['小规']!, 'rule-qa', c.tenantCtx),
  })
  const kbCount = (kb.output as { count: number }).count
  assert(kbCount > 0, `kb_search 命中 ${kbCount} 条`)

  // compliance_check：极限词应命中违规
  const comp = await c.registry.execute({
    skillKey: 'compliance_check',
    input: { title: '玻尿酸补水面膜 全网最低价 100%有效', category: '化妆品', description: '国家级检测认证 行业第一' },
    skillCtx: skillCtx(0, employees['扫雷']!, 'risk-scanner', c.tenantCtx),
  })
  const violations = (comp.output as { violations: unknown[] }).violations
  assert(violations.length > 0, `compliance_check 命中 ${violations.length} 处违规`)

  // run_readonly_sql：只读查询订单表 应返回行
  const sql = await c.registry.execute({
    skillKey: 'run_readonly_sql',
    input: { question: '订单总数', sql: 'SELECT count(*) AS n FROM orders' },
    skillCtx: skillCtx(0, employees['周报姬']!, 'report-analyst', c.tenantCtx),
  })
  const rowCount = (sql.output as { rowCount: number }).rowCount
  assert(rowCount > 0, `run_readonly_sql 返回 ${rowCount} 行`)
}

/** 单个 LLM 回合：processSync 全流程 打印流式增量计数与技能事件时间线
 * 为什么空回答重试一次：deepseek-flash 在工具调用后偶发不产最终文本（空流）
 *   重试时加一句「直接给出最终回答」的指令 是弱模型工具循环的务实补偿 属 demo 层容错不改 runtime */
async function turn(c: ScenarioCtx, sessionId: number, message: string, label: string): Promise<string> {
  let assistantText = ''
  let epoch = 0

  for (let attempt = 0; attempt < 2 && assistantText.trim().length === 0; attempt++) {
    const prompt = attempt === 0 ? message : `${message}（请直接给出最终回答 不要再调用工具）`
    console.log(`\n[${label}] 用户：「${prompt}」${attempt > 0 ? '（重试）' : ''}`)
    const before = await c.events.replay(sessionId, 0)
    const beforeMaxId = before.length > 0 ? before[before.length - 1]!.id : 0

    let deltaCount = 0
    const res = await c.turns.processSync(sessionId, prompt, c.tenantCtx, async () => {
      deltaCount++
    })
    assistantText = res.assistantText
    epoch = res.epoch

    const after = await c.events.replay(sessionId, beforeMaxId)
    const skillEvents = after.filter(e => e.type.startsWith('SKILL') || e.type === 'TURN_ERROR')
    for (const e of skillEvents) {
      console.log(`  [事件] ${e.type} ${JSON.stringify(e.payloadJson ?? {}).slice(0, 160)}`)
    }
    console.log(`  [${label}] 流式增量 ${deltaCount} 片 epoch=${epoch} 字数=${assistantText.length}`)
  }

  assert(assistantText.trim().length > 0, `${label} 产出非空回答（重试后仍为空 epoch=${epoch}）`)
  console.log(`  [${label}] 回答摘要：${assistantText.slice(0, 120).replace(/\n/g, ' ')}...`)
  return assistantText
}

async function main(): Promise<void> {
  console.log('===== demo:scenario 好物严选接管剧本 =====')

  const { prisma, redis, gateway, retrieval, chunks, registry, sessions, turns, events } = await buildDemoServices()

  // 定位 demo 企业与六员工
  const enterprise = await prisma.enterprise.findUniqueOrThrow({ where: { slug: 'haowu-yanxuan' } })
  const owner = await prisma.member.findFirst({ where: { enterpriseId: enterprise.id, role: 'OWNER' } })
  if (!owner) throw new ScenarioError('demo 企业缺 OWNER 成员 先 pnpm db:seed')

  const tenantCtx: TenantCtx = { enterpriseId: enterprise.id, memberId: owner.id, role: 'OWNER' }

  const empRows = await prisma.siliconEmployee.findMany({ where: { enterpriseId: enterprise.id } })
  const employees: Record<string, number> = {}
  for (const e of empRows) employees[e.displayName] = e.id
  for (const name of ['小规', '售后侠', '扫雷', '周报姬']) {
    assert(employees[name] !== undefined, `员工「${name}」已就位`)
  }

  // 语料入库（幂等）
  const dataset = await prisma.knowledgeDataset.findFirst({ where: { enterpriseId: enterprise.id, name: '规则知识库' } })
  if (!dataset) throw new ScenarioError('知识库未找到 先 pnpm db:seed')
  console.log('\n[0] 上传语料（corpus → 知识库）')
  const ingestRes = await ingestCorpus({
    prisma, gateway, chunks,
    enterpriseId: enterprise.id, datasetId: dataset.id, memberId: owner.id,
    corpusDir: path.join(REPO_ROOT, 'corpus'),
  })
  assert(ingestRes.files > 0, `语料入库 文件=${ingestRes.files} 新建=${ingestRes.created} 缓存=${ingestRes.cached} chunks=${ingestRes.chunks}`)

  const c: ScenarioCtx = {
    prisma, gateway, retrieval, registry, sessions, turns, events,
    enterpriseId: enterprise.id, memberId: owner.id, tenantCtx,
  }

  await skillSelfChecks(c, employees)

  // 建会话 阵容四员工（slot 顺序决定接管候选 首员工即当前持有者=小规）
  console.log('\n[2] 建会话 阵容 = 小规 → 售后侠 → 扫雷 → 周报姬')
  const session = await sessions.create({
    enterpriseId: enterprise.id,
    title: '好物严选接管演示',
    participantEmployeeIds: [employees['小规']!, employees['售后侠']!, employees['扫雷']!, employees['周报姬']!],
  })
  assert(session.currentParticipantId === employees['小规'], `当前持有者=小规（id=${session.currentParticipantId}）`)

  // 回合 1：小规答疑（INJECT 知识库注入）
  await turn(c, session.id, '你好，我想问七天无理由退货从哪天开始起算？', '回合1·小规答疑')

  // 接管 → 售后侠
  const t1 = await sessions.adminTakeover({ sessionId: session.id, enterpriseId: enterprise.id, employeeId: employees['售后侠']!, reason: '转售后工单' })
  assert(t1.ok && t1.newHolderId === employees['售后侠'], `接管 → 售后侠（新 epoch=${t1.newEpoch}）`)

  // 回合 2：售后工单（分类 + 政策）
  await turn(c, session.id, '有个工单：用户说收到玻尿酸面膜后脸部泛红，申请全额退款，麻烦分类一下并给出政策依据。', '回合2·售后工单')

  // 接管 → 扫雷
  const t2 = await sessions.adminTakeover({ sessionId: session.id, enterpriseId: enterprise.id, employeeId: employees['扫雷']!, reason: '转合规扫描' })
  assert(t2.ok && t2.newHolderId === employees['扫雷'], `接管 → 扫雷（新 epoch=${t2.newEpoch}）`)

  // 回合 3：扫雷合规（compliance_check 工具）
  await turn(c, session.id, '帮我检查这个商品标题是否合规：「玻尿酸补水面膜 全网最低价 100%有效」类目是化妆品。', '回合3·扫雷合规')

  // 接管 → 周报姬
  const t3 = await sessions.adminTakeover({ sessionId: session.id, enterpriseId: enterprise.id, employeeId: employees['周报姬']!, reason: '转周报' })
  assert(t3.ok && t3.newHolderId === employees['周报姬'], `接管 → 周报姬（新 epoch=${t3.newEpoch}）`)

  // 回合 4：周报（run_readonly_sql 工具）
  // 为什么提示 Postgres 语法：deepseek-flash 默认生成 MySQL 函数（WEEKDAY）会被 PGlite 拒绝 显式约束简单聚合
  await turn(c, session.id, '帮我用只读查询统计订单和退款数据：分别执行 SELECT COUNT(*) FROM orders 和 SELECT COUNT(*) FROM refunds 两条，用 Postgres 语法，不要用日期函数。', '回合4·周报')

  // 终态断言：接管事件与消息 epoch 序列
  console.log('\n[3] 终态断言')
  const eventsRows = await events.replay(session.id, 0)
  const takeoverCount = eventsRows.filter(e => e.type === 'TAKEOVER').length
  assert(takeoverCount === 3, `TAKEOVER 事件 3 次（实际 ${takeoverCount}）`)

  const msgs = await prisma.conversationMessage.findMany({ where: { sessionId: session.id }, orderBy: { id: 'asc' }, select: { role: true, epoch: true, text: true } })
  const epochs = msgs.map(m => m.epoch)

  // 每个 turn 写两条消息（user+assistant）共享同一 epoch 故按「去重后的 turn epoch」断言单调递增
  const turnEpochs: number[] = []
  for (const e of epochs) {
    if (turnEpochs[turnEpochs.length - 1] !== e) turnEpochs.push(e)
  }
  const increasing = turnEpochs.every((v, i) => i === 0 || v > (turnEpochs[i - 1] ?? 0))
  assert(increasing, `turn epoch 单调递增（${turnEpochs.join(',')}）`)
  assert(epochs.length % 2 === 0, `消息成对落库 user+assistant（${epochs.length} 条）`)

  const finalSession = await prisma.conversationSession.findUnique({ where: { id: session.id } })
  assert(finalSession?.currentParticipantId === employees['周报姬'], `最终持有者=周报姬`)

  console.log('\n===== demo:scenario 全部断言通过 =====')
  console.log(`会话 id=${session.id} 消息 ${msgs.length} 条 事件 ${eventsRows.length} 条`)

  await redis.quit()
  await prisma.$disconnect()
}

main().catch(async e => {
  console.error(`\n[scenario] 失败: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
