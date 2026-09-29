import { z } from 'zod'

/**
 * 请求级租户上下文（ALS 载体 见 10-骨架/04 §6）
 * 前后端与所有模块共用
 */
export interface TenantCtx {
  enterpriseId: number
  memberId: number
  role: 'OWNER' | 'ADMIN' | 'MEMBER'
}

/** 检索命中项 两路排名与融合分都返回 供评测与前端可视化 */
export interface RetrievalHit {
  chunkId: number
  docId: number
  content: string
  headingPath?: string | null
  page?: number | null
  /** 向量路名次（该路未参与则为 undefined） */
  vectorRank?: number
  /** 词法路名次 */
  lexicalRank?: number
  /** 融合得分（单路时即该路折算分） */
  rrfScore: number
}

// ===== gateway 区（任务 A 在此追加） =====

// ===== rag 区（任务 B 在此追加） =====

// ===== runtime 区（任务 C 在此追加） =====

// ===== skills 区（任务 H 在此追加） =====

// ===== web 区（任务 E 在此追加） =====

/** 成员角色 与 Prisma MemberRole 对齐 */
export type MemberRole = 'OWNER' | 'ADMIN' | 'MEMBER'

/** 模板状态 与 Prisma TemplateStatus 对齐 */
export const TemplateStatuses = ['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'] as const
export type TemplateStatusValue = (typeof TemplateStatuses)[number]

/** 文档入库状态 与 Prisma DocStatus 对齐 */
export const DocStatuses = ['UPLOADED', 'QUEUED', 'PARSING', 'INDEXED', 'FAILED', 'OCR_NEEDED'] as const
export type DocStatusValue = (typeof DocStatuses)[number]

/** 授权 scope 类型 与 Prisma GrantScopeType 对齐 */
export type GrantScopeType = 'ENTERPRISE' | 'DEPARTMENT' | 'MEMBER'

/** 登录/注册成功返回的当前成员信息 */
export interface MeInfo {
  memberId: number
  enterpriseId: number
  enterpriseName: string
  displayName: string
  email: string
  role: MemberRole
}

/** 数字员工摘要 会话列表/徽标/选阵容共用 */
export interface EmployeeSummary {
  id: number
  displayName: string
  avatar: string | null
  templateSlug: string
  templateVersion: number
  status: string
}

/** 会话列表条目 */
export interface SessionSummary {
  id: number
  title: string | null
  status: string
  currentParticipantId: number | null
  lastMessageAt: string | null
  participants: EmployeeSummary[]
}

/** 会话内消息 服务端回放形态 parts 存 AI SDK UIMessage 的 parts */
export interface ChatMessageItem {
  id: string
  role: 'USER' | 'ASSISTANT'
  parts: unknown[]
  text: string
  employeeId: number | null
  createdAt: string
}

/** 会话详情 */
export interface SessionDetail extends SessionSummary {
  epoch: number
  messages: ChatMessageItem[]
}

/** 执行事件 时间线条目 */
export interface ExecutionEventItem {
  id: number
  type: string
  employeeId: number | null
  payload: unknown | null
  createdAt: string
}

/** 数据集摘要 */
export interface DatasetSummary {
  id: number
  name: string
  description: string | null
  docCount: number
}

/** 文档摘要 */
export interface DocSummary {
  id: number
  title: string
  status: DocStatusValue
  parseError: string | null
  chunkCount: number
  sizeBytes: number
  mimeType: string
  createdAt: string
}

/** 技能定义摘要 */
export interface SkillSummary {
  key: string
  name: string
  type: string
  description: string
  riskLevel: number
}

/** 模板摘要 */
export interface TemplateSummary {
  id: number
  slug: string
  version: number
  name: string
  description: string
  systemPrompt: string
  avatar: string | null
  status: TemplateStatusValue
  reviewNote: string | null
  publishedAt: string | null
  skillBindings: { skillKey: string; configJson: unknown }[]
  kbBindings: { datasetId: number; kbMode: string }[]
}

/** 包版本摘要 */
export interface PackageVersionSummary {
  version: number
  status: TemplateStatusValue
  publishedAt: string | null
  items: { templateSlug: string; templateVersion: number }[]
}

/** 订阅包摘要 */
export interface PackageSummary {
  id: number
  slug: string
  name: string
  description: string
  versions: PackageVersionSummary[]
}

/** 订阅摘要 锁定版本是核心语义 */
export interface SubscriptionSummary {
  id: number
  packageId: number
  packageName: string
  lockedPackageVersion: number
  latestVersion: number
  status: string
  startedAt: string
  expiresAt: string | null
  employees: EmployeeSummary[]
}

/** 升级 diff 预览 对比锁定版本与最新版本 */
export interface UpgradeDiff {
  fromVersion: number
  toVersion: number
  added: { templateSlug: string; templateVersion: number }[]
  removed: { templateSlug: string; templateVersion: number }[]
  changed: { templateSlug: string; from: number; to: number }[]
}

/** 部门节点 物化路径渲染成树 */
export interface DepartmentNode {
  id: number
  name: string
  parentId: number | null
  path: string
  sortOrder: number
  children: DepartmentNode[]
}

/** 成员摘要 */
export interface MemberSummary {
  id: number
  displayName: string
  email: string
  role: MemberRole
  departmentId: number | null
  status: string
}

/** 授权条目 */
export interface GrantSummary {
  id: number
  employeeId: number
  employeeName: string
  scopeType: GrantScopeType
  scopeId: number | null
  status: string
}

/** 成本汇总行 与网关 admin/usage/summary 对齐 */
export interface UsageGroup {
  enterpriseId: number | null
  routeAlias: string
  day: string
  calls: number
  inputTokens: number
  outputTokens: number
  costCny: string
}

// ===== 基础 DTO（任务 0） =====

/** 会话 turn 请求体 */
export const ChatTurnRequestSchema = z.object({
  sessionId: z.number().int().positive(),
  message: z.string().min(1).max(4000),
})
export type ChatTurnRequest = z.infer<typeof ChatTurnRequestSchema>

/** 技能类型常量（与 Prisma enum 对齐） */
export const SkillTypes = ['BUILTIN_FUNCTION', 'HTTP_RPA', 'EXTERNAL_AGENT'] as const
export type SkillTypeValue = (typeof SkillTypes)[number]
