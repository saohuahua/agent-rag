/**
 * mock 内存数据库 后端未就绪时的假数据源
 * 只被 app/api/mock/** 的 route handler import 不进入客户端 bundle
 * 数据按 enterpriseId 分租户 与真实后端 ALS+行过滤语义对齐
 * 事件订阅者集合用于 turns 流写事件时实时推给 events SSE 让时间线滚动
 */

import type {
  DatasetSummary,
  DepartmentNode,
  DocSummary,
  EmployeeSummary,
  ExecutionEventItem,
  GrantSummary,
  MemberSummary,
  MeInfo,
  PackageSummary,
  SessionDetail,
  SessionSummary,
  SkillSummary,
  SubscriptionSummary,
  TemplateSummary,
  UsageGroup,
} from '@agent-rag/shared'

/** mock 会话 cookie 名 值 base64 JSON {enterpriseId memberId role} */
export const MOCK_COOKIE = 'mock_session'

/** 从请求读登录态 未登录返回 null */
export function readAuth(req: Request): { enterpriseId: number; memberId: number; role: string } | null {
  // route handler 的 Request 无 cookie API 从 header 手工解析
  const header = req.headers.get('cookie') ?? ''
  for (const pair of header.split(';')) {
    const [k, v] = pair.split('=')
    if (k?.trim() !== MOCK_COOKIE) continue
    try {
      const raw = Buffer.from(decodeURIComponent(v ?? ''), 'base64').toString('utf8')
      const parsed = JSON.parse(raw) as { enterpriseId: number; memberId: number; role: string }
      if (typeof parsed.enterpriseId === 'number' && typeof parsed.memberId === 'number') return parsed
    } catch {
      return null
    }
  }
  return null
}

/** 构造登录态 cookie 值 */
export function buildCookie(enterpriseId: number, memberId: number, role: string): string {
  return Buffer.from(JSON.stringify({ enterpriseId, memberId, role })).toString('base64')
}

/** 内部实体类型 比对外 DTO 多内部字段 */
interface MockDoc extends DocSummary {
  datasetId: number
  enterpriseId: number
  sourceType: string
  storageKey: string
  checksum: string
  uploadedBy: number
  /** 上传时刻 用于模拟状态推进 */
  statusT0: number
}

interface MockMessage {
  id: string
  sessionId: number
  role: 'USER' | 'ASSISTANT'
  employeeId: number | null
  parts: unknown[]
  text: string
  createdAt: string
}

interface MockEvent {
  id: number
  sessionId: number
  employeeId: number | null
  type: string
  payload: unknown | null
  createdAt: string
}

interface MockSession {
  id: number
  enterpriseId: number
  title: string | null
  status: string
  currentParticipantId: number | null
  epoch: number
  lastMessageAt: string | null
  participantEmployeeIds: number[]
}

interface MockTemplate {
  id: number
  slug: string
  version: number
  name: string
  description: string
  systemPrompt: string
  avatar: string | null
  status: TemplateSummary['status']
  reviewNote: string | null
  publishedAt: string | null
  skillBindings: { skillKey: string; configJson: unknown }[]
  kbBindings: { datasetId: number; kbMode: string }[]
}

interface MockPackageVersion {
  version: number
  status: TemplateSummary['status']
  publishedAt: string | null
  items: { templateSlug: string; templateVersion: number }[]
}

interface MockPackage {
  id: number
  slug: string
  name: string
  description: string
  versions: MockPackageVersion[]
}

interface MockGrant {
  id: number
  enterpriseId: number
  employeeId: number
  scopeType: 'ENTERPRISE' | 'DEPARTMENT' | 'MEMBER'
  scopeId: number | null
  status: string
}

interface MockEmployee {
  id: number
  enterpriseId: number
  subscriptionId: number
  displayName: string
  avatar: string | null
  templateSlug: string
  templateVersion: number
  status: string
}

interface MockDataset {
  id: number
  enterpriseId: number
  name: string
  description: string | null
}

interface MockMember {
  id: number
  enterpriseId: number
  email: string
  password: string
  displayName: string
  role: 'OWNER' | 'ADMIN' | 'MEMBER'
  departmentId: number | null
  status: string
}

interface MockDepartment {
  id: number
  enterpriseId: number
  parentId: number | null
  name: string
  path: string
  sortOrder: number
}

interface MockSubscription {
  id: number
  enterpriseId: number
  packageId: number
  lockedPackageVersion: number
  status: string
  startedAt: string
  expiresAt: string | null
}

/** 内存库单例 */
interface MockDb {
  members: MockMember[]
  departments: MockDepartment[]
  employees: MockEmployee[]
  grants: MockGrant[]
  datasets: MockDataset[]
  docs: MockDoc[]
  sessions: MockSession[]
  messages: MockMessage[]
  events: MockEvent[]
  templates: MockTemplate[]
  skills: SkillSummary[]
  packages: MockPackage[]
  subscriptions: MockSubscription[]
  usage: UsageGroup[]
  /** 每个会话的活跃事件订阅者 turns 写事件时向它们推送 */
  eventSubscribers: Map<number, Set<(ev: ExecutionEventItem) => void>>
  /** 自增 id 计数器 */
  seq: Record<string, number>
}

/** 取下一个自增 id */
function nextId(db: MockDb, key: string): number {
  db.seq[key] = (db.seq[key] ?? 0) + 1
  return db.seq[key] as number
}

/** 生成伪随机 slug 注册新企业用 */
function randomSlug(): string {
  return `e${Math.random().toString(36).slice(2, 8)}`
}

/** 固定前缀的 id 字符串 消息 id 用 */
function msgId(prefix: string, n: number): string {
  return `${prefix}-${n}`
}

/** 播种两个租户的演示数据 */
function seed(): MockDb {
  const db: MockDb = {
    members: [],
    departments: [],
    employees: [],
    grants: [],
    datasets: [],
    docs: [],
    sessions: [],
    messages: [],
    events: [],
    templates: [],
    skills: [],
    packages: [],
    subscriptions: [],
    usage: [],
    eventSubscribers: new Map(),
    seq: {},
  }

  // ---- 平台级技能 所有企业共用 ----
  db.skills = [
    { key: 'kb_search', name: '知识库检索', type: 'BUILTIN_FUNCTION', description: '检索企业知识库 返回带出处的问题答案', riskLevel: 1 },
    { key: 'operate_ticket', name: '工单操作', type: 'HTTP_RPA', description: '操作售后工单系统 查询/改状态/退款', riskLevel: 2 },
    { key: 'compliance_scan', name: '合规扫描', type: 'BUILTIN_FUNCTION', description: '扫描文本中的广告法/禁限售风险词', riskLevel: 2 },
    { key: 'ask_expert', name: '外部专家', type: 'EXTERNAL_AGENT', description: '疑难问题转交外部人工专家', riskLevel: 3 },
  ]

  // ---- 平台级模板 跨企业可订阅 ----
  const afterSalePrompt =
    '你是售后侠 一名电商售后客服 语气亲切专业 先安抚情绪再给方案 退款退货引用平台规则原文 无法回答时转接扫雷官做合规复核'
  db.templates = [
    {
      id: nextId(db, 'template'),
      slug: 'after-sale',
      version: 1,
      name: '售后侠',
      description: '电商售后客服 处理退款退货投诉',
      systemPrompt: afterSalePrompt,
      avatar: null,
      status: 'PUBLISHED',
      reviewNote: null,
      publishedAt: '2026-09-01T10:00:00.000Z',
      skillBindings: [
        { skillKey: 'kb_search', configJson: { datasetId: 1 } },
        { skillKey: 'operate_ticket', configJson: {} },
      ],
      kbBindings: [{ datasetId: 1, kbMode: 'BOTH' }],
    },
    {
      id: nextId(db, 'template'),
      slug: 'compliance-scan',
      version: 1,
      name: '扫雷官',
      description: '合规扫描 广告法禁限售风险词核查',
      systemPrompt: '你是扫雷官 负责合规扫描 逐条列出风险词与依据法条 结论用表格输出',
      avatar: null,
      status: 'PUBLISHED',
      reviewNote: null,
      publishedAt: '2026-09-01T10:00:00.000Z',
      skillBindings: [{ skillKey: 'compliance_scan', configJson: {} }],
      kbBindings: [{ datasetId: 2, kbMode: 'TOOL' }],
    },
    {
      id: nextId(db, 'template'),
      slug: 'weekly-report',
      version: 1,
      name: '周报员',
      description: '汇总一周工单数据产出周报',
      systemPrompt: '你是周报员 汇总售后数据产出结构化周报 结论先行',
      avatar: null,
      status: 'PUBLISHED',
      reviewNote: null,
      publishedAt: '2026-09-01T10:00:00.000Z',
      skillBindings: [{ skillKey: 'operate_ticket', configJson: {} }],
      kbBindings: [],
    },
    {
      id: nextId(db, 'template'),
      slug: 'after-sale',
      version: 2,
      name: '售后侠',
      description: '售后侠 v2 新增工单自动升级能力',
      systemPrompt: afterSalePrompt + ' 遇到超时未解决工单自动升级到主管',
      avatar: null,
      status: 'PENDING_REVIEW',
      reviewNote: null,
      publishedAt: null,
      skillBindings: [
        { skillKey: 'kb_search', configJson: { datasetId: 1 } },
        { skillKey: 'operate_ticket', configJson: {} },
        { skillKey: 'ask_expert', configJson: {} },
      ],
      kbBindings: [{ datasetId: 1, kbMode: 'BOTH' }],
    },
  ]

  // ---- 订阅包 ----
  db.packages = [
    {
      id: nextId(db, 'package'),
      slug: 'service-standard',
      name: '标准客服包',
      description: '售后侠 + 扫雷官 双员工阵容',
      versions: [
        {
          version: 1,
          status: 'PUBLISHED',
          publishedAt: '2026-09-01T10:00:00.000Z',
          items: [
            { templateSlug: 'after-sale', templateVersion: 1 },
            { templateSlug: 'compliance-scan', templateVersion: 1 },
          ],
        },
        {
          version: 2,
          status: 'DRAFT',
          publishedAt: null,
          items: [
            { templateSlug: 'after-sale', templateVersion: 2 },
            { templateSlug: 'compliance-scan', templateVersion: 1 },
            { templateSlug: 'weekly-report', templateVersion: 1 },
          ],
        },
      ],
    },
  ]

  // ---- 企业 1 美妆严选 ----
  const e1 = 1
  db.departments.push(
    { id: nextId(db, 'dept'), enterpriseId: e1, parentId: null, name: '美妆严选', path: '/1/', sortOrder: 0 },
    { id: nextId(db, 'dept'), enterpriseId: e1, parentId: 1, name: '客服部', path: '/1/2/', sortOrder: 0 },
    { id: nextId(db, 'dept'), enterpriseId: e1, parentId: 1, name: '合规部', path: '/1/3/', sortOrder: 1 },
    { id: nextId(db, 'dept'), enterpriseId: e1, parentId: 2, name: '客服一组', path: '/1/2/4/', sortOrder: 0 },
  )

  db.members.push(
    { id: nextId(db, 'member'), enterpriseId: e1, email: 'owner1@demo.com', password: '123456', displayName: '王掌柜', role: 'OWNER', departmentId: 1, status: 'ACTIVE' },
    { id: nextId(db, 'member'), enterpriseId: e1, email: 'admin1@demo.com', password: '123456', displayName: '李审核', role: 'ADMIN', departmentId: 2, status: 'ACTIVE' },
    { id: nextId(db, 'member'), enterpriseId: e1, email: 'staff1@demo.com', password: '123456', displayName: '张小二', role: 'MEMBER', departmentId: 4, status: 'ACTIVE' },
  )

  const sub1: MockSubscription = {
    id: nextId(db, 'sub'),
    enterpriseId: e1,
    packageId: 1,
    lockedPackageVersion: 1,
    status: 'ACTIVE',
    startedAt: '2026-09-02T08:00:00.000Z',
    expiresAt: null,
  }
  db.subscriptions.push(sub1)

  db.employees.push(
    { id: nextId(db, 'emp'), enterpriseId: e1, subscriptionId: sub1.id, displayName: '售后侠', avatar: null, templateSlug: 'after-sale', templateVersion: 1, status: 'ACTIVE' },
    { id: nextId(db, 'emp'), enterpriseId: e1, subscriptionId: sub1.id, displayName: '扫雷官', avatar: null, templateSlug: 'compliance-scan', templateVersion: 1, status: 'ACTIVE' },
    { id: nextId(db, 'emp'), enterpriseId: e1, subscriptionId: sub1.id, displayName: '周报员', avatar: null, templateSlug: 'weekly-report', templateVersion: 1, status: 'ACTIVE' },
  )

  db.grants.push(
    { id: nextId(db, 'grant'), enterpriseId: e1, employeeId: 1, scopeType: 'ENTERPRISE', scopeId: null, status: 'ACTIVE' },
    { id: nextId(db, 'grant'), enterpriseId: e1, employeeId: 2, scopeType: 'ENTERPRISE', scopeId: null, status: 'ACTIVE' },
    { id: nextId(db, 'grant'), enterpriseId: e1, employeeId: 3, scopeType: 'ENTERPRISE', scopeId: null, status: 'ACTIVE' },
  )

  db.datasets.push(
    { id: nextId(db, 'ds'), enterpriseId: e1, name: '售后政策库', description: '退款退货 投诉处理等售后规则' },
    { id: nextId(db, 'ds'), enterpriseId: e1, name: '平台合规库', description: '广告法 禁限售目录等合规红线' },
  )

  db.docs.push(
    { id: nextId(db, 'doc'), datasetId: 1, enterpriseId: e1, title: '七天无理由退货规则.pdf', status: 'INDEXED', parseError: null, chunkCount: 24, sizeBytes: 482000, mimeType: 'application/pdf', sourceType: 'UPLOAD', storageKey: 's3://mock/1.pdf', checksum: 'c1', uploadedBy: 1, createdAt: '2026-09-03T09:00:00.000Z', statusT0: 0 },
    { id: nextId(db, 'doc'), datasetId: 1, enterpriseId: e1, title: '投诉处理流程.pdf', status: 'INDEXED', parseError: null, chunkCount: 18, sizeBytes: 301000, mimeType: 'application/pdf', sourceType: 'UPLOAD', storageKey: 's3://mock/2.pdf', checksum: 'c2', uploadedBy: 1, createdAt: '2026-09-03T09:30:00.000Z', statusT0: 0 },
    { id: nextId(db, 'doc'), datasetId: 2, enterpriseId: e1, title: '禁限售商品目录.docx', status: 'OCR_NEEDED', parseError: '扫描件无文本层 需要 OCR 人工介入', chunkCount: 0, sizeBytes: 520000, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sourceType: 'UPLOAD', storageKey: 's3://mock/3.docx', checksum: 'c3', uploadedBy: 1, createdAt: '2026-09-04T10:00:00.000Z', statusT0: 0 },
    { id: nextId(db, 'doc'), datasetId: 2, enterpriseId: e1, title: '广告法红线速查.pdf', status: 'PARSING', parseError: null, chunkCount: 6, sizeBytes: 210000, mimeType: 'application/pdf', sourceType: 'UPLOAD', storageKey: 's3://mock/4.pdf', checksum: 'c4', uploadedBy: 1, createdAt: new Date().toISOString(), statusT0: Date.now() - 3000 },
    { id: nextId(db, 'doc'), datasetId: 2, enterpriseId: e1, title: '旧版优惠券规则.pdf', status: 'FAILED', parseError: 'PDF 解析失败 encrypted or corrupted', chunkCount: 0, sizeBytes: 90000, mimeType: 'application/pdf', sourceType: 'UPLOAD', storageKey: 's3://mock/5.pdf', checksum: 'c5', uploadedBy: 1, createdAt: '2026-09-05T11:00:00.000Z', statusT0: 0 },
  )

  // 会话 1 售后侠 + 扫雷官 已有历史与事件
  const s1: MockSession = {
    id: nextId(db, 'session'),
    enterpriseId: e1,
    title: '退货流程咨询',
    status: 'ACTIVE',
    currentParticipantId: 1,
    epoch: 2,
    lastMessageAt: '2026-09-05T12:00:00.000Z',
    participantEmployeeIds: [1, 2],
  }
  db.sessions.push(s1)

  db.messages.push(
    { id: msgId('m', nextId(db, 'msg')), sessionId: s1.id, role: 'USER', employeeId: null, parts: [{ type: 'text', text: '我买的口红过敏了能退吗' }], text: '我买的口红过敏了能退吗', createdAt: '2026-09-05T11:58:00.000Z' },
    { id: msgId('m', nextId(db, 'msg')), sessionId: s1.id, role: 'ASSISTANT', employeeId: 1, parts: [{ type: 'text', text: '亲 别着急 过敏属于商品质量问题 可以七天无理由退货 我帮您查一下规则' }], text: '亲 别着急 过敏属于商品质量问题 可以七天无理由退货 我帮您查一下规则', createdAt: '2026-09-05T12:00:00.000Z' },
  )

  db.events.push(
    { id: nextId(db, 'ev'), sessionId: s1.id, employeeId: 1, type: 'TURN_START', payload: { epoch: 1 }, createdAt: '2026-09-05T11:58:00.100Z' },
    { id: nextId(db, 'ev'), sessionId: s1.id, employeeId: 1, type: 'SKILL_START', payload: { skill: 'kb_search' }, createdAt: '2026-09-05T11:58:01.000Z' },
    { id: nextId(db, 'ev'), sessionId: s1.id, employeeId: 1, type: 'SKILL_END', payload: { skill: 'kb_search', hits: 3 }, createdAt: '2026-09-05T11:58:02.500Z' },
    { id: nextId(db, 'ev'), sessionId: s1.id, employeeId: 1, type: 'TURN_END', payload: { epoch: 1 }, createdAt: '2026-09-05T12:00:00.200Z' },
  )

  // ---- 企业 2 数码极客 ----
  const e2 = 2
  const deptE2 = nextId(db, 'dept')
  db.departments.push({ id: deptE2, enterpriseId: e2, parentId: null, name: '数码极客', path: `/${deptE2}/`, sortOrder: 0 })

  const memberE2 = nextId(db, 'member')
  db.members.push(
    { id: memberE2, enterpriseId: e2, email: 'owner2@demo.com', password: '123456', displayName: '陈掌柜', role: 'OWNER', departmentId: deptE2, status: 'ACTIVE' },
  )

  const sub2: MockSubscription = {
    id: nextId(db, 'sub'),
    enterpriseId: e2,
    packageId: 1,
    lockedPackageVersion: 1,
    status: 'ACTIVE',
    startedAt: '2026-09-02T09:00:00.000Z',
    expiresAt: null,
  }
  db.subscriptions.push(sub2)

  const empE2AfterSale = nextId(db, 'emp')
  const empE2Sweeper = nextId(db, 'emp')
  db.employees.push(
    { id: empE2AfterSale, enterpriseId: e2, subscriptionId: sub2.id, displayName: '售后侠', avatar: null, templateSlug: 'after-sale', templateVersion: 1, status: 'ACTIVE' },
    { id: empE2Sweeper, enterpriseId: e2, subscriptionId: sub2.id, displayName: '扫雷官', avatar: null, templateSlug: 'compliance-scan', templateVersion: 1, status: 'ACTIVE' },
  )

  db.grants.push(
    { id: nextId(db, 'grant'), enterpriseId: e2, employeeId: empE2AfterSale, scopeType: 'ENTERPRISE', scopeId: null, status: 'ACTIVE' },
    { id: nextId(db, 'grant'), enterpriseId: e2, employeeId: empE2Sweeper, scopeType: 'ENTERPRISE', scopeId: null, status: 'ACTIVE' },
  )

  const dsE2 = nextId(db, 'ds')
  db.datasets.push({ id: dsE2, enterpriseId: e2, name: '数码售后库', description: '保修政策 退换货规则' })
  db.docs.push(
    { id: nextId(db, 'doc'), datasetId: dsE2, enterpriseId: e2, title: '保修政策.pdf', status: 'INDEXED', parseError: null, chunkCount: 12, sizeBytes: 180000, mimeType: 'application/pdf', sourceType: 'UPLOAD', storageKey: 's3://mock/11.pdf', checksum: 'c11', uploadedBy: memberE2, createdAt: '2026-09-03T10:00:00.000Z', statusT0: 0 },
  )

  const s2: MockSession = {
    id: nextId(db, 'session'),
    enterpriseId: e2,
    title: '手机保修咨询',
    status: 'ACTIVE',
    currentParticipantId: empE2AfterSale,
    epoch: 1,
    lastMessageAt: '2026-09-05T13:00:00.000Z',
    participantEmployeeIds: [empE2AfterSale],
  }
  db.sessions.push(s2)
  db.messages.push(
    { id: msgId('m', nextId(db, 'msg')), sessionId: s2.id, role: 'USER', employeeId: null, parts: [{ type: 'text', text: '手机在保期内屏幕坏了' }], text: '手机在保期内屏幕坏了', createdAt: '2026-09-05T12:59:00.000Z' },
  )

  // 注册新建企业从 3 开始 避免与种子企业 1/2 冲突
  db.seq['enterprise'] = 2

  // ---- 用量报表 ----
  const days = ['2026-09-03', '2026-09-04', '2026-09-05']
  for (const [i, day] of days.entries()) {
    db.usage.push({ enterpriseId: e1, routeAlias: 'chat', day, calls: 20 + i * 8, inputTokens: 4000 + i * 1200, outputTokens: 1500 + i * 500, costCny: (0.85 + i * 0.31).toFixed(2) })
    db.usage.push({ enterpriseId: e1, routeAlias: 'strong-chat', day, calls: 3 + i, inputTokens: 2000 + i * 400, outputTokens: 800 + i * 200, costCny: (0.5 + i * 0.15).toFixed(2) })
    db.usage.push({ enterpriseId: e1, routeAlias: 'embedding', day, calls: 30 + i * 5, inputTokens: 6000 + i * 900, outputTokens: 0, costCny: (0.05 + i * 0.01).toFixed(2) })
    db.usage.push({ enterpriseId: e2, routeAlias: 'chat', day, calls: 5 + i * 2, inputTokens: 900 + i * 150, outputTokens: 400 + i * 60, costCny: (0.2 + i * 0.05).toFixed(2) })
  }

  return db
}

/** 单例 模块首次加载时播种 */
export const db = seed()

/** 对外自增 id 分配 route handler 创建新记录用 */
export function nextIdFor(key: string): number {
  return nextId(db, key)
}

// ==================== 查询辅助 均按租户过滤 ====================

/** 根据登录态返回当前成员 未登录返回 null */
export function currentMember(req: Request): MockMember | null {
  const auth = readAuth(req)
  if (!auth) return null
  return db.members.find((m) => m.id === auth.memberId) ?? null
}

/** 转对外 me 信息 企业名取该企业根部门名 */
export function toMe(m: MockMember): MeInfo {
  const root = db.departments.find((d) => d.enterpriseId === m.enterpriseId && d.parentId === null)
  return {
    memberId: m.id,
    enterpriseId: m.enterpriseId,
    enterpriseName: root?.name ?? `企业${m.enterpriseId}`,
    displayName: m.displayName,
    email: m.email,
    role: m.role,
  }
}

/** 转对外员工摘要 */
export function toEmployee(e: MockEmployee): EmployeeSummary {
  return {
    id: e.id,
    displayName: e.displayName,
    avatar: e.avatar,
    templateSlug: e.templateSlug,
    templateVersion: e.templateVersion,
    status: e.status,
  }
}

/** 会话列表条目 */
export function toSessionSummary(s: MockSession): SessionSummary {
  const participants = s.participantEmployeeIds
    .map((id) => db.employees.find((e) => e.id === id))
    .filter((e): e is MockEmployee => e !== undefined)
    .map(toEmployee)
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    currentParticipantId: s.currentParticipantId,
    lastMessageAt: s.lastMessageAt,
    participants,
  }
}

/** 会话详情 含消息 */
export function toSessionDetail(s: MockSession): SessionDetail {
  const messages = db.messages
    .filter((m) => m.sessionId === s.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((m) => ({
      id: m.id,
      role: m.role,
      parts: m.parts,
      text: m.text,
      employeeId: m.employeeId,
      createdAt: m.createdAt,
    }))
  return { ...toSessionSummary(s), epoch: s.epoch, messages }
}

/** 数据集摘要 含文档数 */
export function toDatasetSummary(d: MockDataset): DatasetSummary {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    docCount: db.docs.filter((doc) => doc.datasetId === d.id).length,
  }
}

/** 文档摘要 去内部字段 */
export function toDocSummary(d: MockDoc): DocSummary {
  const { datasetId, enterpriseId, sourceType, storageKey, checksum, uploadedBy, statusT0, ...rest } = d
  void datasetId
  void enterpriseId
  void sourceType
  void storageKey
  void checksum
  void uploadedBy
  void statusT0
  return rest
}

/** 模板摘要 只暴露必要字段 */
export function toTemplateSummary(t: MockTemplate): TemplateSummary {
  return {
    id: t.id,
    slug: t.slug,
    version: t.version,
    name: t.name,
    description: t.description,
    systemPrompt: t.systemPrompt,
    avatar: t.avatar,
    status: t.status,
    reviewNote: t.reviewNote,
    publishedAt: t.publishedAt,
    skillBindings: t.skillBindings,
    kbBindings: t.kbBindings,
  }
}

/** 包摘要 */
export function toPackageSummary(p: MockPackage): PackageSummary {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    versions: p.versions.map((v) => ({ version: v.version, status: v.status, publishedAt: v.publishedAt, items: v.items })),
  }
}

/** 订阅摘要 含锁定版本与最新可升级版本与员工 */
export function toSubscriptionSummary(s: MockSubscription): SubscriptionSummary {
  const pkg = db.packages.find((p) => p.id === s.packageId)
  const latest = pkg?.versions.find((v) => v.status === 'PUBLISHED')?.version ?? s.lockedPackageVersion
  const employees = db.employees.filter((e) => e.subscriptionId === s.id).map(toEmployee)
  return {
    id: s.id,
    packageId: s.packageId,
    packageName: pkg?.name ?? '',
    lockedPackageVersion: s.lockedPackageVersion,
    latestVersion: latest,
    status: s.status,
    startedAt: s.startedAt,
    expiresAt: s.expiresAt,
    employees,
  }
}

/** 授权摘要 */
export function toGrantSummary(g: MockGrant): GrantSummary {
  const emp = db.employees.find((e) => e.id === g.employeeId)
  return {
    id: g.id,
    employeeId: g.employeeId,
    employeeName: emp?.displayName ?? '',
    scopeType: g.scopeType,
    scopeId: g.scopeId,
    status: g.status,
  }
}

/** 成员摘要 */
export function toMemberSummary(m: MockMember): MemberSummary {
  return {
    id: m.id,
    displayName: m.displayName,
    email: m.email,
    role: m.role,
    departmentId: m.departmentId,
    status: m.status,
  }
}

/** 部门树 由平铺列表按 path 关系组装 */
export function buildDeptTree(enterpriseId: number): DepartmentNode[] {
  const list = db.departments.filter((d) => d.enterpriseId === enterpriseId)
  const nodes = new Map<number, DepartmentNode>()
  for (const d of list) {
    nodes.set(d.id, { id: d.id, name: d.name, parentId: d.parentId, path: d.path, sortOrder: d.sortOrder, children: [] })
  }
  const roots: DepartmentNode[] = []
  for (const d of list) {
    const node = nodes.get(d.id)
    if (!node) continue
    if (d.parentId !== null) {
      const parent = nodes.get(d.parentId)
      parent?.children.push(node)
    } else {
      roots.push(node)
    }
  }
  // 递归按 sortOrder 排序
  const sortRec = (n: DepartmentNode) => {
    n.children.sort((a, b) => a.sortOrder - b.sortOrder)
    n.children.forEach(sortRec)
  }
  roots.sort((a, b) => a.sortOrder - b.sortOrder)
  roots.forEach(sortRec)
  return roots
}

/** 模拟文档状态推进 依据上传后经过的时间 让上传进度轮询可见 */
export function advanceDocStatus(doc: MockDoc): void {
  if (doc.status !== 'UPLOADED' && doc.status !== 'QUEUED' && doc.status !== 'PARSING') return
  const elapsed = Date.now() - doc.statusT0
  if (elapsed >= 12000) {
    doc.status = 'INDEXED'
    doc.chunkCount = Math.max(doc.chunkCount, 8 + Math.floor(Math.random() * 16))
  } else if (elapsed >= 5000) {
    doc.status = 'PARSING'
    doc.chunkCount = Math.max(doc.chunkCount, 2 + Math.floor(Math.random() * 5))
  } else if (elapsed >= 2000) {
    doc.status = 'QUEUED'
  }
}

/** 向某会话推送事件 写入事件表并广播给活跃订阅者 */
export function emitEvent(sessionId: number, employeeId: number | null, type: string, payload: unknown): ExecutionEventItem {
  const ev: MockEvent = {
    id: nextId(db, 'ev'),
    sessionId,
    employeeId,
    type,
    payload,
    createdAt: new Date().toISOString(),
  }
  db.events.push(ev)
  const item: ExecutionEventItem = { id: ev.id, type: ev.type, employeeId: ev.employeeId, payload: ev.payload, createdAt: ev.createdAt }
  const subs = db.eventSubscribers.get(sessionId)
  if (subs) {
    for (const fn of subs) fn(item)
  }
  return item
}

/** 检索测试台 mock 双路结果 固定序列便于可视化 */
export function mockSearchHits(query: string, enterpriseId: number) {
  void query
  void enterpriseId
  // 构造 6 条命中 向量路与词法路名次不同 体现双路互补
  const base = [
    { chunkId: 11, docId: 1, content: '七天无理由退货：自签收起 7 日内 不影响二次销售 可无理由退货 运费由买家承担', headingPath: '售后政策 > 退货', page: 2 },
    { chunkId: 12, docId: 1, content: '商品质量问题：过敏 破损 功能故障 属于质量问题 由商家承担退货运费', headingPath: '售后政策 > 质量问题', page: 3 },
    { chunkId: 13, docId: 2, content: '投诉处理时限：普通投诉 24 小时内响应 48 小时内给出处理方案', headingPath: '投诉处理', page: 1 },
    { chunkId: 14, docId: 1, content: '退款到账：审核通过后 3-5 个工作日原路退回', headingPath: '售后政策 > 退款', page: 5 },
    { chunkId: 15, docId: 2, content: '升级投诉：用户情绪激动 涉及金额较大 应升级到主管处理', headingPath: '投诉处理 > 升级', page: 4 },
    { chunkId: 16, docId: 1, content: '退换货时效：签收后 15 日内可换货 超过 15 日仅维修', headingPath: '售后政策 > 换货', page: 6 },
  ]
  // 向量路名次 语义相近排前面
  const vectorRank = [1, 2, 4, 3, 6, 5]
  // 词法路名次 精确词命中排前面
  const lexicalRank = [3, 1, 2, 5, 4, 6]
  // RRF 融合 k=60 只用排名
  const rrf = (r: number) => 1 / (60 + r)
  return base.map((b, i) => {
    const vr = vectorRank[i] as number
    const lr = lexicalRank[i] as number
    return {
      ...b,
      vectorRank: vr,
      lexicalRank: lr,
      rrfScore: Number((rrf(vr) + rrf(lr)).toFixed(6)),
    }
  })
}

// 重新导出便于 route handler 复用内部类型
export type { MockDoc, MockMessage, MockEvent, MockSession, MockTemplate, MockPackage, MockEmployee, MockDataset, MockMember, MockGrant, MockSubscription }
