import type { SkillDef } from '../skill-executor'
import { KbSearchDef } from './kb-search'
import { ComplianceCheckDef } from './compliance'
import { BatchScanDef } from './batch-scan'
import { TicketClassifyDef } from './ticket-classify'
import { OperateTicketDef } from './operate-ticket'
import { RunReadonlySqlDef } from './readonly-sql'
import { ConsultCreativeAgentDef } from './consult-creative-agent'

/**
 * 全部技能定义列表 顺序即上架顺序 runtime 据此构建 AI SDK tools
 * 注：conversation.handover 是 runtime 内置技能（C 任务实现）不在此列表
 */
export const SKILL_DEFS: SkillDef[] = [
  KbSearchDef,
  ComplianceCheckDef,
  BatchScanDef,
  TicketClassifyDef,
  OperateTicketDef,
  RunReadonlySqlDef,
  ConsultCreativeAgentDef,
]
