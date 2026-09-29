import { notFound, requireMember, badRequest } from '../../../_lib/http'
import { db, emitEvent, nextIdFor } from '../../../_lib/store'

/**
 * turn 流式响应 mock
 * 返回 AI SDK UI Message Stream（SSE）给 useChat 的 DefaultChatTransport 解析
 * 同时写执行事件并实时推给 events SSE 让右侧时间线滚动
 * 命中「扫雷/合规/广告」等词时触发 handover 切换当前员工徽标
 */

/** 让流按节拍输出 模拟打字机 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 按字符切块 每块 2-4 字 营造打字机效果 */
function chunkText(text: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const size = 2 + Math.floor(Math.random() * 3)
    out.push(text.slice(i, i + size))
    i += size
  }
  return out
}

/** 是否触发转接 命中合规类词则交给扫雷官 */
function wantsHandover(message: string): boolean {
  return /扫雷|合规|广告|禁限售|宣传|绝对化/.test(message)
}

/** 售后侠的回答 */
const AFTER_SALE_REPLY =
  '好的 我查了《七天无理由退货规则》 亲这种情况可以退 依据是 签收起 7 日内 不影响二次销售可无理由退货 运费由买家承担 如果属于质量问题 比如过敏破损 运费由商家承担 我帮您登记一个工单 稍后短信同步进度'

/** 售后侠转接话术 */
const HANDOVER_LEAD = '这个问题涉及广告宣传合规 我请扫雷官帮您复核一下'

/** 扫雷官的回答 */
const COMPLIANCE_REPLY =
  '我来做合规扫描 您提到的宣传语含 最 字 属于广告法第九条禁止的绝对化用语 建议改为 优质 或 出众 已生成风险清单并附依据法条 需要的话我把清单发给您'

/** 向 SSE 控制器写一行 data */
function writeChunk(controller: ReadableStreamDefaultController<Uint8Array>, obj: unknown): void {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`))
}

/** 写 AI SDK 文本增量 */
function writeDelta(controller: ReadableStreamDefaultController<Uint8Array>, textId: string, delta: string): void {
  writeChunk(controller, { type: 'text-delta', id: textId, delta })
}

/**
 * turn 主处理 只返回流 Response 生成过程异步写入
 * @param req 请求
 * @param ctx 路由参数含会话 id
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = requireMember(req)
  if (member instanceof Response) return member

  const { id } = await ctx.params
  const session = db.sessions.find((s) => s.id === Number(id) && s.enterpriseId === member.enterpriseId)
  if (!session) return notFound()

  let body: { message?: string }
  try {
    body = await req.json()
  } catch {
    return badRequest('invalid json body')
  }
  const message = (body.message ?? '').trim()
  if (!message) return badRequest('message required')

  // 持久化用户消息
  const now = new Date().toISOString()
  db.messages.push({
    id: `m-${nextIdFor('msg')}`,
    sessionId: session.id,
    role: 'USER',
    employeeId: null,
    parts: [{ type: 'text', text: message }],
    text: message,
    createdAt: now,
  })
  session.lastMessageAt = now

  const holderId = session.currentParticipantId
  const handover = wantsHandover(message)
  // 下一个参与者 用于 handover 切换
  const nextIdx = session.participantEmployeeIds.indexOf(holderId ?? -1) + 1
  const nextEmployee = handover && nextIdx > 0 ? session.participantEmployeeIds[nextIdx] ?? null : null

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 关闭前的收尾 记录最终状态
      const finish = async () => {
        writeChunk(controller, { type: 'finish', finishReason: 'stop' })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }

      try {
        // 流协议开头 无 messageId 由前端生成
        writeChunk(controller, { type: 'start' })

        // TURN_START 事件
        emitEvent(session.id, holderId, 'TURN_START', { epoch: session.epoch + 1 })

        // kb_search 工具调用事件
        writeChunk(controller, { type: 'start-step' })
        emitEvent(session.id, holderId, 'SKILL_START', { skill: 'kb_search', query: message })
        await sleep(500)
        emitEvent(session.id, holderId, 'SKILL_END', { skill: 'kb_search', hits: 3, topDataset: '售后政策库' })
        await sleep(300)

        // 售后侠正文 打字机
        const firstText = handover ? HANDOVER_LEAD : AFTER_SALE_REPLY
        writeChunk(controller, { type: 'text-start', id: 't1' })
        for (const piece of chunkText(firstText)) {
          writeDelta(controller, 't1', piece)
          await sleep(60)
        }
        writeChunk(controller, { type: 'text-end', id: 't1' })
        writeChunk(controller, { type: 'finish-step' })

        // 持久化售后侠消息
        db.messages.push({
          id: `m-${nextIdFor('msg')}`,
          sessionId: session.id,
          role: 'ASSISTANT',
          employeeId: holderId,
          parts: [{ type: 'text', text: firstText }],
          text: firstText,
          createdAt: new Date().toISOString(),
        })

        // handover 场景 切换当前持有者并让扫雷官接续
        if (handover && nextEmployee !== null) {
          emitEvent(session.id, holderId, 'TAKEOVER', {
            fromEmployeeId: holderId,
            toEmployeeId: nextEmployee,
            reason: '涉及合规风险 转接扫雷官',
          })
          session.currentParticipantId = nextEmployee
          await sleep(600)

          writeChunk(controller, { type: 'start-step' })
          emitEvent(session.id, nextEmployee, 'SKILL_START', { skill: 'compliance_scan' })
          await sleep(500)
          emitEvent(session.id, nextEmployee, 'SKILL_END', { skill: 'compliance_scan', riskWords: ['最', '第一', '绝对'] })
          await sleep(300)

          writeChunk(controller, { type: 'text-start', id: 't2' })
          for (const piece of chunkText(COMPLIANCE_REPLY)) {
            writeDelta(controller, 't2', piece)
            await sleep(60)
          }
          writeChunk(controller, { type: 'text-end', id: 't2' })
          writeChunk(controller, { type: 'finish-step' })

          db.messages.push({
            id: `m-${nextIdFor('msg')}`,
            sessionId: session.id,
            role: 'ASSISTANT',
            employeeId: nextEmployee,
            parts: [{ type: 'text', text: COMPLIANCE_REPLY }],
            text: COMPLIANCE_REPLY,
            createdAt: new Date().toISOString(),
          })
        }

        // epoch 递增 结束事件
        session.epoch += 1
        session.lastMessageAt = new Date().toISOString()
        emitEvent(session.id, session.currentParticipantId, 'TURN_END', { epoch: session.epoch })

        await finish()
      } catch (e) {
        // 流中途失败 尽力告知客户端
        writeChunk(controller, { type: 'error', errorText: e instanceof Error ? e.message : 'stream error' })
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-vercel-ai-ui-message-stream': 'v1',
    },
  })
}
