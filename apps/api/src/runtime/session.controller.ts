import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common'
import type { Response } from 'express'
import { InjectQueue } from '@nestjs/bullmq'
import type { Queue } from 'bullmq'
import { z } from 'zod'
import { EnterpriseContextService } from '../tenant/enterprise-context.service'
import { SessionService } from './session.service'
import { TurnProcessor, AGENT_TURN_QUEUE } from './turn.processor'
import type { AgentTurnJobData } from './turn.processor'
import { EventsService } from './events.service'

/** 建会话入参 */
const CreateSessionSchema = z.object({
  title: z.string().max(200).optional(),
  participantEmployeeIds: z.array(z.number().int().positive()).min(1),
})

/** turn 请求体 */
const TurnRequestSchema = z.object({
  message: z.string().min(1).max(4000),
})

/** 管理接管入参 */
const TakeoverSchema = z.object({
  employeeId: z.number().int().positive(),
})

/**
 * 会话控制器：CRUD / turn 发起（异步 worker + 同步降级）/ 事件 SSE 断线续传
 * 授权：企业隔离由 EnterpriseContextService.require() 拿到 TenantCtx 后按 enterpriseId 校验
 */
@Controller('sessions')
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly turnProcessor: TurnProcessor,
    private readonly events: EventsService,
    private readonly ctxService: EnterpriseContextService,
    @InjectQueue(AGENT_TURN_QUEUE) private readonly queue: Queue<AgentTurnJobData>,
  ) {}

  /** 建会话（阵容校验+授权见 SessionService.create） */
  @Post()
  async create(@Body() body: unknown) {
    const req = this.parse(CreateSessionSchema, body)
    const ctx = this.ctxService.require()
    return this.sessions.create({
      enterpriseId: ctx.enterpriseId,
      title: req.title,
      participantEmployeeIds: req.participantEmployeeIds,
    })
  }

  /** 会话列表（本企业） */
  @Get()
  async list() {
    const ctx = this.ctxService.require()
    return this.sessions.list(ctx.enterpriseId)
  }

  /** 会话详情（消息+参与者+当前持有者+epoch） */
  @Get(':id')
  async detail(@Param('id', ParseIntPipe) sessionId: number) {
    const ctx = this.ctxService.require()
    return this.sessions.getDetail(sessionId, ctx.enterpriseId)
  }

  /**
   * 发起 turn
   * mode=sync：同步降级版 请求内直接跑完整流程 delta 直接写 SSE（锁仍生效）
   * 默认 async：入队后 202 返回 delta 经 Redis pub/sub 桥接由 SSE 转发
   */
  @Post(':id/turns')
  async createTurn(
    @Param('id', ParseIntPipe) sessionId: number,
    @Body() body: unknown,
    @Query('mode') mode: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const req = this.parse(TurnRequestSchema, body)
    const ctx = this.ctxService.require()

    if (mode === 'sync') {
      await this.streamSyncTurn(res, sessionId, req.message, ctx)
      return
    }

    await this.queue.add(AGENT_TURN_QUEUE, { sessionId, message: req.message, ctx })
    res.status(202)
    await this.streamWorkerDeltas(res, sessionId)
  }

  /** 事件 SSE：实时订阅 + afterId 断线续传 */
  @Get(':id/events')
  async eventsStream(
    @Param('id', ParseIntPipe) sessionId: number,
    @Query('afterId') afterId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = this.ctxService.require()
    // 先做归属校验 无权直接 403 不建立流
    await this.sessions.getDetail(sessionId, ctx.enterpriseId)

    this.initSse(res)
    const after = afterId !== undefined ? Number(afterId) : undefined

    try {
      for await (const evt of this.events.subscribe(sessionId, Number.isFinite(after) ? after : undefined)) {
        res.write(`data: ${JSON.stringify({ id: evt.id, type: evt.type, payload: evt.payloadJson })}\n\n`)
      }
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: e instanceof Error ? e.message : 'event stream error' })}\n\n`)
      res.end()
    }
  }

  /** 同步降级版 turn 流 */
  private async streamSyncTurn(res: Response, sessionId: number, message: string, ctx: ReturnType<EnterpriseContextService['require']>): Promise<void> {
    this.initSse(res)

    try {
      await this.turnProcessor.processSync(sessionId, message, ctx, async delta => {
        res.write(`data: ${JSON.stringify({ type: 'delta', delta })}\n\n`)
      })
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
      res.end()
    } catch (e) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: e instanceof Error ? e.message : 'turn failed' })}\n\n`)
      res.end()
    }
  }

  /** 异步 worker 版：订阅 pub/sub 流桥并转发到 SSE */
  private async streamWorkerDeltas(res: Response, sessionId: number): Promise<void> {
    this.initSse(res)

    try {
      for await (const delta of this.events.subscribeDeltas(sessionId)) {
        res.write(`data: ${JSON.stringify({ type: 'delta', delta })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
      res.end()
    } catch (e) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: e instanceof Error ? e.message : 'stream failed' })}\n\n`)
      res.end()
    }
  }

  /** SSE 响应头初始化 */
  private initSse(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()
  }

  /** zod 校验 失败抛 400 */
  private parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    return parsed.data
  }
}

/**
 * 管理端会话控制器：接管等管理动作
 * 与 SessionController 分开是为了路由前缀 /admin/sessions
 */
@Controller('admin/sessions')
export class SessionAdminController {
  constructor(
    private readonly sessions: SessionService,
    private readonly ctxService: EnterpriseContextService,
  ) {}

  /** 管理接管：锁保护下 epoch++ + 切换当前持有者 */
  @Post(':id/takeover')
  async takeover(@Param('id', ParseIntPipe) sessionId: number, @Body() body: unknown) {
    const req = TakeoverSchema.parse(body)
    const ctx = this.ctxService.require()
    return this.sessions.adminTakeover({
      sessionId,
      enterpriseId: ctx.enterpriseId,
      employeeId: req.employeeId,
    })
  }
}
