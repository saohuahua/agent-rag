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
