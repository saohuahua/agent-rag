import { Injectable } from '@nestjs/common'
import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import type { TenantCtx } from '@agent-rag/shared'
import { SkillExecutorRegistry } from '../skills/skill-executor'
import type { EventSink, SkillCtx, SkillResult } from '../skills/skill-executor'

/**
 * handover 执行结果 返回给 LLM 供其向用户说明转接结果
 * ok=false 时 error 是给 LLM 的失败摘要（目标不在阵容等）
 */
export interface HandoverResult {
  ok: boolean
  newHolderId: number | null
  /** 接管后自增的新 epoch 当前 turn 需采纳它继续后续写 否则 epoch 校验被拒 */
  newEpoch?: number
  error?: string
}

/** handover 回调 由 turn.processor 注入 内部完成校验+锁+epoch+切换+事件 */
export type HandoverFn = (opts: { targetEmployeeKey: string; reason: string }) => Promise<HandoverResult>

/** 构建工具集所需的一次 turn 上下文 */
export interface ToolboxContext {
  sessionId: number
  employeeId: number
  templateSlug: string
  /** skillKey → 该模板绑定时的参数注入 configJson */
  skillConfigs: ReadonlyMap<string, unknown | null>
  tenantCtx?: TenantCtx
  /** 事件回传 写 execution_events + 推 SSE */
  emit: EventSink
  /** 内置 conversation.handover 的落地逻辑 */
  handover: HandoverFn
}

/**
 * 工具箱：把技能台账包装成 AI SDK tool + 内置 conversation.handover
 * 为什么每个技能都包装成 tool()：AI SDK 统一执行 execute 并把结果回喂 LLM
 * 三类异构能力（函数/HTTP RPA/外部 agent）在此收敛成一个入口 内部由 registry 分发
 * handover 是「多员工接管」的灵魂触发器 由 LLM 自主调用完成岗位轮转
 */
@Injectable()
export class ToolboxService {
  constructor(private readonly registry: SkillExecutorRegistry) {}

  /**
   * 构建一次 turn 的工具集
   * @param ctx 见 ToolboxContext 决定绑定哪些技能与事件归属
   * @returns AI SDK ToolSet（技能工具 + 内置 handover）
   */
  build(ctx: ToolboxContext): ToolSet {
    const tools: ToolSet = {}

    // 技能工具：只暴露当前模板绑定的技能（台账全集→模板子集）
    for (const def of this.registry.listDefs()) {
      if (!ctx.skillConfigs.has(def.key)) continue

      const configJson = ctx.skillConfigs.get(def.key) ?? null

      tools[def.key] = tool({
        description: def.description,
        inputSchema: def.inputSchema,
        execute: async input => this.executeSkill(def.key, input, ctx, configJson),
      })
    }

    // 内置 handover 工具 每个会话都有
    tools['conversation.handover'] = this.buildHandoverTool(ctx)

    return tools
  }

  /** 当前模板绑定技能的清单说明（进 system prompt 帮助 LLM 知晓能力边界） */
  toolDescriptions(skillConfigs: ReadonlyMap<string, unknown | null>): string[] {
    return this.registry
      .listDefs()
      .filter(d => skillConfigs.has(d.key))
      .map(d => `${d.key}: ${d.description}`)
  }

  /** 技能执行：SKILL_START → registry.execute → SKILL_END 失败回喂错误摘要 */
  private async executeSkill(
    skillKey: string,
    input: unknown,
    ctx: ToolboxContext,
    configJson: unknown | null,
  ): Promise<unknown> {
    await ctx.emit('SKILL_START', { skillKey })

    const skillCtx: SkillCtx = {
      sessionId: ctx.sessionId,
      employeeId: ctx.employeeId,
      templateSlug: ctx.templateSlug,
      configJson,
      ctx: ctx.tenantCtx,
      emit: ctx.emit,
    }

    try {
      const result: SkillResult = await this.registry.execute({ skillKey, input, skillCtx })
      await ctx.emit('SKILL_END', { skillKey, summary: result.summary })
      // output 必须 JSON 可序列化 直接回喂 LLM 让其基于结构化结果继续生成
      return result.output
    } catch (e) {
      const message = e instanceof Error ? e.message : 'skill execution failed'
      await ctx.emit('SKILL_ERROR', { skillKey, error: message })
      // 失败也回喂错误摘要 让 LLM 能向用户解释而非静默中断
      return { ok: false, error: message }
    }
  }

  /** 内置 conversation.handover 工具 LLM 自主转接岗位 */
  private buildHandoverTool(ctx: ToolboxContext) {
    return tool({
      description:
        '将会话转接给阵容中的另一位员工 当你判断当前问题超出自身职责或更适合其他员工处理时调用 转接后该员工接管后续对话',
      inputSchema: z.object({
        targetEmployeeKey: z.string().describe('目标员工的 displayName 或 id'),
        reason: z.string().describe('转接原因 将展示给用户'),
      }),
      execute: async ({ targetEmployeeKey, reason }) => {
        return ctx.handover({ targetEmployeeKey, reason })
      },
    })
  }
}
