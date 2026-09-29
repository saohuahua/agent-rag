/**
 * Hono 应用装配 所有路由与入参校验都在这里
 * 为什么校验失败抛 AppError 走统一 onError 而不是内联返回: 响应体格式统一 错误码一致
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ZodError } from 'zod'
import { AppError } from './errors'
import {
  ticketIdSchema,
  listQuerySchema,
  transitionBodySchema,
  batchTagBodySchema,
  batchRefundBodySchema,
} from './schemas'
import type { TicketStore } from './store'

/**
 * zod 校验失败转为统一 issues 数组 每条带路径和消息
 * @param error zod 校验错误对象
 */
function zodIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }))
}

/**
 * 读 JSON 请求体 非法 JSON 转 400 而不是抛语法错误变 500
 * @param c Hono 上下文
 */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new AppError('INVALID_JSON', 400, 'request body is not valid json')
  }
}

/**
 * 组装应用 依赖注入 store 便于测试时替换
 * @param store 工单存储实例
 */
export function buildApp(store: TicketStore): Hono {
  const app = new Hono()

  // 健康检查 返回服务名与当前工单数
  app.get('/healthz', (c) => {
    return c.json({ ok: true, service: 'mock-rpa', ticketCount: store.count() })
  })

  // 批量路由先于 /tickets/:id 注册 静态段优先 提前注册更稳妥
  // 批量标记
  app.post('/tickets/batch/tag', async (c) => {
    const body = batchTagBodySchema.safeParse(await readJson(c))
    if (!body.success) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'invalid request body', issues: zodIssues(body.error) }, 400)
    }

    const result = store.batchTag(body.data.ids, body.data.tags, body.data.mode)
    return c.json({ ok: true, ...result })
  })

  // 批量退款
  app.post('/tickets/batch/refund', async (c) => {
    const body = batchRefundBodySchema.safeParse(await readJson(c))
    if (!body.success) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'invalid request body', issues: zodIssues(body.error) }, 400)
    }

    const result = store.batchRefund(body.data.ids, body.data.amount)
    return c.json({ ok: true, ...result })
  })

  // 状态流转 目标态校验 zod 状态机校验 store
  app.post('/tickets/:id/transition', async (c) => {
    const idParsed = ticketIdSchema.safeParse(c.req.param('id'))
    if (!idParsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'invalid ticket id', issues: zodIssues(idParsed.error) }, 400)
    }

    const body = transitionBodySchema.safeParse(await readJson(c))
    if (!body.success) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'invalid request body', issues: zodIssues(body.error) }, 400)
    }

    const ticket = store.transition(idParsed.data, body.data.to)
    return c.json(ticket)
  })

  // 工单列表 分页 + 按店铺 按状态过滤 覆盖按店铺查询和按状态查询
  app.get('/tickets', (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'invalid query params', issues: zodIssues(parsed.error) }, 400)
    }

    const { page, pageSize, shopId, status } = parsed.data
    const result = store.list({ shopId, status }, page, pageSize)
    return c.json(result)
  })

  // 按 id 查单条
  app.get('/tickets/:id', (c) => {
    const parsed = ticketIdSchema.safeParse(c.req.param('id'))
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'invalid ticket id', issues: zodIssues(parsed.error) }, 400)
    }

    const ticket = store.get(parsed.data)
    if (!ticket) {
      throw new AppError('TICKET_NOT_FOUND', 404, `ticket ${parsed.data} not found`)
    }
    return c.json(ticket)
  })

  // 未匹配路由 统一 JSON 404
  app.notFound((c) => {
    return c.json({ error: 'NOT_FOUND', message: `route not found ${c.req.method} ${c.req.path}` }, 404)
  })

  // 统一错误处理 AppError 按码转响应 意外异常兜底 500 不泄露内部细节
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.code, message: err.message }, err.status)
    }

    console.error('[mock-rpa] unexpected error', err)
    return c.json({ error: 'INTERNAL_ERROR', message: 'internal server error' }, 500)
  })

  return app
}
