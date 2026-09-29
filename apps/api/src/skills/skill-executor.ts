import { Injectable } from '@nestjs/common'
import type { ZodType } from 'zod'
import type { TenantCtx } from '@agent-rag/shared'

/** 技能定义（上架台账的代码侧真相） */
export interface SkillDef {
  key: string
  type: 'BUILTIN_FUNCTION' | 'HTTP_RPA' | 'EXTERNAL_AGENT'
  /** 给 LLM 看的用途描述 直接进 tool description */
  description: string
  /** zod schema 即工具入参协议 */
  inputSchema: ZodType
  riskLevel: 1 | 2 | 3
}

/**
 * 事件回传以函数参数注入 避免 skills→runtime 的反向依赖
 * emit 由 runtime 构建工具时注入 内部写 execution_events 并推 SSE
 */
export type EventSink = (type: string, payload?: unknown) => Promise<void>

/** 技能执行上下文 */
export interface SkillCtx {
  sessionId: number
  employeeId: number
  templateSlug: string
  /** 模板绑定该技能时的参数注入 如 { datasetId: 3 } */
  configJson: unknown | null
  ctx?: TenantCtx
  /** 发 SKILL_PROGRESS 等事件 */
  emit: EventSink
}

/** 执行结果 output 必须可 JSON 序列化 summary 是给 LLM 的一句话摘要 */
export interface SkillResult {
  output: unknown
  summary: string
}

/**
 * [桩] 任务 H 将替换为真实现（契约见 10-骨架/04 §5）
 * registry + 按 type 分发到 builtin/http-rpa/external-agent 执行器
 */
@Injectable()
export class SkillExecutorRegistry {
  /** 全部可用技能的定义（runtime 据此构建 tools） */
  listDefs(): SkillDef[] {
    throw new Error('NOT_IMPLEMENTED: skills.listDefs (任务H)')
  }

  /** 按 key 执行 入参先过 inputSchema 校验 非法输入抛 SkillInputError */
  async execute(opts: {
    skillKey: string
    input: unknown
    skillCtx: SkillCtx
  }): Promise<SkillResult> {
    throw new Error('NOT_IMPLEMENTED: skills.execute (任务H)')
  }
}
