import Redis from 'ioredis'
import { EnvService } from '../config/env.service'
import { PrismaService } from '../prisma/prisma.service'
import { UsageMeterService } from '../gateway/usage-meter.service'
import { ProviderRegistry } from '../gateway/provider-registry'
import { HealthTracker } from '../gateway/health-tracker'
import { ModelRouter } from '../gateway/model-router'
import { BudgetGuard } from '../gateway/budget-guard'
import { GatewayService } from '../gateway/gateway.service'
import { ChunkRepository } from '../rag/chunk.repository'
import { RetrievalService } from '../rag/retrieval.service'
import { KbSearchExecutor } from '../skills/executors/builtin/kb-search'
import { ComplianceExecutor } from '../skills/executors/builtin/compliance'
import { TicketClassifyExecutor } from '../skills/executors/builtin/ticket-classify'
import { ReadonlySqlExecutor } from '../skills/executors/builtin/readonly-sql'
import { HttpRpaExecutor } from '../skills/executors/http-rpa'
import { ExternalAgentExecutor } from '../skills/executors/external-agent'
import { SkillExecutorRegistry } from '../skills/skill-executor'
import { SessionLockService } from '../runtime/session-lock.service'
import { EventsService } from '../runtime/events.service'
import { SessionService } from '../runtime/session.service'
import { ContextBuilder } from '../runtime/context-builder'
import { ToolboxService } from '../runtime/toolbox'
import { TurnProcessor } from '../runtime/turn.processor'
import { DemoChatModelResolver } from './chat-model-resolver'

/**
 * demo 脚本共享的服务装配（手动 new 全依赖图 不用 Nest DI）
 * 为什么手动装配而非 createApplicationContext：tsx/esbuild 不产出 design:paramtypes
 *   Nest 在 tsx 下无法自动解析构造参数（实测 Reflect.getMetadata 为 undefined）
 *   手动 new 沿用了 C 任务 concurrency-demo.ts 的先例 且依赖顺序一眼可读
 * 依赖方向严格遵守 10-骨架/04 §0 的单向图：gateway → rag → skills → runtime
 */
export interface DemoServices {
  env: EnvService
  prisma: PrismaService
  redis: Redis
  gateway: GatewayService
  retrieval: RetrievalService
  chunks: ChunkRepository
  registry: SkillExecutorRegistry
  sessions: SessionService
  turns: TurnProcessor
  events: EventsService
  lock: SessionLockService
  meter: UsageMeterService
}

/** 装配全部服务并建立连接 返回聚合对象 */
export async function buildDemoServices(): Promise<DemoServices> {
  const env = new EnvService()
  const prisma = new PrismaService(env)
  await prisma.$connect()
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })

  // 网关栈（计价/健康/降级链/预算）
  const meter = new UsageMeterService(prisma)
  const providers = new ProviderRegistry(prisma, env)
  const health = new HealthTracker()
  const router = new ModelRouter(prisma, providers, health, meter)
  const budget = new BudgetGuard(prisma)
  const gateway = new GatewayService(router, budget)

  // RAG 栈
  const chunks = new ChunkRepository(prisma)
  const retrieval = new RetrievalService(gateway, chunks)

  // 技能栈（三类执行器 → 注册表）
  const kbSearch = new KbSearchExecutor(retrieval)
  const compliance = new ComplianceExecutor()
  const ticketClassify = new TicketClassifyExecutor(gateway)
  const readonlySql = new ReadonlySqlExecutor(prisma)
  const httpRpa = new HttpRpaExecutor(meter)
  const externalAgent = new ExternalAgentExecutor(gateway, meter)
  const registry = new SkillExecutorRegistry(kbSearch, compliance, ticketClassify, readonlySql, httpRpa, externalAgent)

  // runtime 栈（锁/事件/会话/上下文/工具箱/模型解析/turn 主流程）
  const lock = new SessionLockService(redis, prisma)
  const events = new EventsService(prisma, redis)
  const sessions = new SessionService(prisma, lock, events)
  const contextBuilder = new ContextBuilder(retrieval)
  const toolbox = new ToolboxService(registry)
  const resolver = new DemoChatModelResolver(prisma, env)
  const turns = new TurnProcessor(prisma, lock, contextBuilder, toolbox, events, sessions, resolver)

  return { env, prisma, redis, gateway, retrieval, chunks, registry, sessions, turns, events, lock, meter }
}
