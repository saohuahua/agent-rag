import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ToolboxService } from '../../src/runtime/toolbox'
import { SkillExecutorRegistry } from '../../src/skills/skill-executor'
import type { SkillDef } from '../../src/skills/skill-executor'

/** 造假 registry 记录 execute 调用 */
function fakeRegistry(defs: SkillDef[], result = { output: { a: 1 }, summary: 'ok' }) {
  const execute = vi.fn().mockResolvedValue(result)
  const registry = { listDefs: () => defs, execute } as unknown as SkillExecutorRegistry
  return { registry, execute }
}

const kbDef: SkillDef = {
  key: 'kb_search',
  type: 'BUILTIN_FUNCTION',
  description: '检索知识库',
  inputSchema: z.object({ query: z.string() }),
  riskLevel: 1,
}

const operateDef: SkillDef = {
  key: 'operate_ticket',
  type: 'HTTP_RPA',
  description: '操作工单',
  inputSchema: z.object({ action: z.string() }),
  riskLevel: 2,
}

/** 默认工具上下文 */
const ctx = {
  sessionId: 1,
  employeeId: 2,
  templateSlug: 'rule-qa',
  tenantCtx: undefined,
  emit: async () => {},
  handover: async () => ({ ok: true, newHolderId: 2 }),
}

describe('工具箱 技能包装 + 内置 handover', () => {
  it('只暴露模板绑定的技能 + 内置 handover', () => {
    const { registry } = fakeRegistry([kbDef, operateDef])
    const toolbox = new ToolboxService(registry)

    const tools = toolbox.build({ ...ctx, skillConfigs: new Map([['kb_search', null]]) })

    expect(Object.keys(tools)).toContain('kb_search')
    expect(Object.keys(tools)).not.toContain('operate_ticket')
    expect(Object.keys(tools)).toContain('conversation.handover')
  })

  it('技能执行发 SKILL_START/SKILL_END 并带绑定参数调用 registry', async () => {
    const { registry, execute } = fakeRegistry([kbDef])
    const toolbox = new ToolboxService(registry)

    const emitted: string[] = []
    const tools = toolbox.build({
      ...ctx,
      skillConfigs: new Map([['kb_search', { datasetId: 3 }]]),
      emit: async type => {
        emitted.push(type)
      },
    })

    // tool() 返回 ExecutableTool execute 存在 此断言安全
    const tool = tools['kb_search'] as unknown as { execute: (input: unknown) => Promise<unknown> }
    const output = await tool.execute({ query: '退货政策' })

    expect(output).toEqual({ a: 1 })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      skillKey: 'kb_search',
      input: { query: '退货政策' },
      skillCtx: { sessionId: 1, employeeId: 2, configJson: { datasetId: 3 } },
    })
    expect(emitted).toEqual(['SKILL_START', 'SKILL_END'])
  })

  it('技能执行失败发 SKILL_ERROR 并回喂错误摘要', async () => {
    const { registry } = fakeRegistry([kbDef])
    const execute = vi.fn().mockRejectedValue(new Error('检索失败'))
    registry.execute = execute
    const toolbox = new ToolboxService(registry)

    const emitted: string[] = []
    const tools = toolbox.build({
      ...ctx,
      skillConfigs: new Map([['kb_search', null]]),
      emit: async type => {
        emitted.push(type)
      },
    })

    const tool = tools['kb_search'] as unknown as { execute: (input: unknown) => Promise<unknown> }
    const output = await tool.execute({ query: 'x' })

    expect(output).toMatchObject({ ok: false })
    expect(emitted).toEqual(['SKILL_START', 'SKILL_ERROR'])
  })

  it('内置 handover 工具调用注入的 handover 回调', async () => {
    const { registry } = fakeRegistry([])
    const toolbox = new ToolboxService(registry)
    const handover = vi.fn().mockResolvedValue({ ok: true, newHolderId: 9 })

    const tools = toolbox.build({ ...ctx, skillConfigs: new Map(), handover })
    const ht = tools['conversation.handover'] as unknown as {
      execute: (input: { targetEmployeeKey: string; reason: string }) => Promise<unknown>
    }

    const res = await ht.execute({ targetEmployeeKey: '扫雷', reason: '转接给扫描员' })

    expect(handover).toHaveBeenCalledWith({ targetEmployeeKey: '扫雷', reason: '转接给扫描员' })
    expect(res).toEqual({ ok: true, newHolderId: 9 })
  })
})
