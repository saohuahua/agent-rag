import { Module } from '@nestjs/common'
import { RagModule } from '../rag/rag.module'
import { SkillExecutorRegistry } from './skill-executor'
import { KbSearchExecutor } from './executors/builtin/kb-search'
import { ComplianceExecutor } from './executors/builtin/compliance'
import { TicketClassifyExecutor } from './executors/builtin/ticket-classify'
import { ReadonlySqlExecutor } from './executors/builtin/readonly-sql'
import { HttpRpaExecutor } from './executors/http-rpa'
import { ExternalAgentExecutor } from './executors/external-agent'

/**
 * 技能执行器模块
 * 导入 RagModule 拿 RetrievalService（kb_search 用）其余依赖 GatewayService UsageMeterService
 * PrismaService EnvService 均为全局模块无需导入
 * 只导出 SkillExecutorRegistry 供 runtime 构建工具 执行器是内部协作件不对外
 */
@Module({
  imports: [RagModule],
  providers: [
    SkillExecutorRegistry,
    KbSearchExecutor,
    ComplianceExecutor,
    TicketClassifyExecutor,
    ReadonlySqlExecutor,
    HttpRpaExecutor,
    ExternalAgentExecutor,
  ],
  exports: [SkillExecutorRegistry],
})
export class SkillsModule {}
