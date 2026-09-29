import { Injectable } from '@nestjs/common'
import type { ZodType } from 'zod'
import type { TenantCtx } from '@agent-rag/shared'
import { SKILL_DEFS } from './defs'
import { KbSearchExecutor } from './executors/builtin/kb-search'
import { ComplianceExecutor } from './executors/builtin/compliance'
import { TicketClassifyExecutor } from './executors/builtin/ticket-classify'
import { ReadonlySqlExecutor } from './executors/builtin/readonly-sql'
import { HttpRpaExecutor } from './executors/http-rpa'
import { ExternalAgentExecutor } from './executors/external-agent'
import { SkillInputError } from './errors'
import type { KbSearchInput } from './defs/kb-search'
import type { ComplianceCheckInput } from './defs/compliance'
import type { TicketClassifyInput } from './defs/ticket-classify'
import type { RunReadonlySqlInput } from './defs/readonly-sql'
import type { ConsultCreativeAgentInput } from './defs/consult-creative-agent'

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
 * 技能执行器注册表（契约实现 签名见 10-骨架/04 §5）
 * 统一执行入口 内部按 Skill.type 分发到三类执行器
 * BUILTIN_FUNCTION 进程内 HTTP_RPA 外部 fetch EXTERNAL_AGENT 经 gateway 起小 agent
 */
@Injectable()
export class SkillExecutorRegistry {
  constructor(
    private readonly kbSearch: KbSearchExecutor,
    private readonly compliance: ComplianceExecutor,
    private readonly ticketClassify: TicketClassifyExecutor,
    private readonly readonlySql: ReadonlySqlExecutor,
    private readonly httpRpa: HttpRpaExecutor,
    private readonly externalAgent: ExternalAgentExecutor,
  ) {}

  /** 全部可用技能的定义（runtime 据此构建 tools） */
  listDefs(): SkillDef[] {
    return SKILL_DEFS
  }

  /** 按 key 执行 入参先过 inputSchema 校验 非法输入抛 SkillInputError */
  async execute(opts: {
    skillKey: string
    input: unknown
    skillCtx: SkillCtx
  }): Promise<SkillResult> {
    const def = SKILL_DEFS.find((d) => d.key === opts.skillKey)
    if (!def) {
      throw new SkillInputError(`unknown skill key=${opts.skillKey}`)
    }

    // 入参先过 zod 校验 非法输入抛 SkillInputError 并透出 issues 给 LLM 自我纠正
    const parsed = def.inputSchema.safeParse(opts.input)
    if (!parsed.success) {
      throw new SkillInputError(
        `invalid input for skill=${opts.skillKey}`,
        parsed.error.issues,
      )
    }
    const input = parsed.data

    // 按 type 分发到三种执行器
    switch (def.type) {
      case 'BUILTIN_FUNCTION':
        return this.runBuiltin(def.key, input, opts.skillCtx)
      case 'HTTP_RPA':
        // RPA 入参必为对象 已由 zod schema 保证 这里的 as 仅是动态分发的收窄
        return this.httpRpa.run(def.key, input as Record<string, unknown>, opts.skillCtx, def.riskLevel)
      case 'EXTERNAL_AGENT':
        return this.externalAgent.run(input as ConsultCreativeAgentInput, opts.skillCtx)
    }
  }

  /** BUILTIN 技能按 key 派发到具体执行器 入参类型已由对应 zod schema 保证 */
  private runBuiltin(key: string, input: unknown, skillCtx: SkillCtx): Promise<SkillResult> {
    switch (key) {
      case 'kb_search':
        return this.kbSearch.run(input as KbSearchInput, skillCtx)
      case 'compliance_check':
        return this.compliance.run(input as ComplianceCheckInput, skillCtx)
      case 'ticket_classify':
        return this.ticketClassify.run(input as TicketClassifyInput, skillCtx)
      case 'run_readonly_sql':
        return this.readonlySql.run(input as RunReadonlySqlInput, skillCtx)
      default:
        throw new SkillInputError(`no builtin handler for key=${key}`)
    }
  }
}
