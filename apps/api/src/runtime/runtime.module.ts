import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { RagModule } from '../rag/rag.module'
import { SkillsModule } from '../skills/skills.module'
import { SessionLockService } from './session-lock.service'
import { ContextBuilder } from './context-builder'
import { ToolboxService } from './toolbox'
import { EventsService } from './events.service'
import { SessionService } from './session.service'
import { TurnProcessor, AGENT_TURN_QUEUE } from './turn.processor'
import { SessionController, SessionAdminController } from './session.controller'
import { CHAT_MODEL_RESOLVER } from './agent-model'
import type { ChatModelResolver } from './agent-model'

/**
 * [桩] 模型解析器 待 J 集成 gateway 真实现
 * 契约变更提案见 C 报告：GatewayService 新增 resolveChatModel(alias)
 * 届时本桩替换为一行委托 gateway 的适配器
 */
const stubModelResolver: ChatModelResolver = {
  async resolve(alias: string) {
    throw new Error(`NOT_IMPLEMENTED: chatModelResolver.resolve(${alias}) (任务C桩 待J接gateway)`)
  },
}

/**
 * Agent Runtime 模块：注册 agent-turn 队列/worker/控制器与会话锁等协作件
 * 依赖 Gateway/Rag/Skills/Tenant 均为全局模块（app.module 已导入）无需重复导入
 */
@Module({
  // Rag/Skills 非 @Global 需显式导入 以注入 RetrievalService 与 SkillExecutorRegistry
  imports: [BullModule.registerQueue({ name: AGENT_TURN_QUEUE }), RagModule, SkillsModule],
  controllers: [SessionController, SessionAdminController],
  providers: [
    SessionLockService,
    ContextBuilder,
    ToolboxService,
    EventsService,
    SessionService,
    TurnProcessor,
    { provide: CHAT_MODEL_RESOLVER, useValue: stubModelResolver },
  ],
  exports: [SessionService, TurnProcessor, EventsService, SessionLockService],
})
export class RuntimeModule {}
