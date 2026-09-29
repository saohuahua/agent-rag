import { BadRequestException, Controller, Post, Body, Res } from '@nestjs/common'
import type { Response } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ModelMessage } from 'ai'
import { GatewayService } from './gateway.service'
import type { UsageInfo } from './gateway.service'

/** 消息内容 支持纯文本与 OpenAI 的 text part 数组两种形态 */
const ContentSchema = z.union([
  z.string(),
  z.array(z.object({ type: z.literal('text'), text: z.string() })),
])

/** OpenAI chat.completions 请求体 model 字段即路由别名 */
const ChatCompletionSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: ContentSchema,
  })).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
})

/** OpenAI embeddings 请求体 model 固定 embedding input 可单可批 */
const EmbeddingsSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string()).min(1)]),
})

/**
 * 网关返回对象在契约（{text, usage}）之外运行时附带 costCny 供响应展示
 * 此类型窄化读取 契约 UsageInfo 不含成本字段
 */
interface ChatResultWithCost {
  text: string
  usage: UsageInfo
  costCny: number
}

/**
 * OpenAI 兼容网关端点 对外长得像 OpenAI 任何客户端可直接调用
 * body.model 是路由别名（chat/strong-chat/embedding）而非真实模型名
 */
@Controller('v1')
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}

  /** 对话补全 支持 stream:true 走 SSE OpenAI chunk 格式 */
  @Post('chat/completions')
  async chatCompletions(@Body() body: unknown, @Res() res: Response): Promise<void> {
    const parsed = ChatCompletionSchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const req = parsed.data

    // zod 校验后的消息结构即 ModelMessage 合法子集 此断言安全
    const messages = req.messages as unknown as ModelMessage[]

    if (req.stream) {
      await this.streamCompletion(res, {
        alias: req.model,
        messages,
        temperature: req.temperature,
        includeUsage: req.stream_options?.include_usage ?? false,
      })
      return
    }

    // 非流式 聚合为 completion 对象
    const created = Math.floor(Date.now() / 1000)
    const { text, usage, costCny } = (await this.gateway.chat({
      messages,
      alias: req.model,
      temperature: req.temperature,
    })) as unknown as ChatResultWithCost

    res.json({
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created,
      model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: this.toUsage(usage, costCny),
    })
  }

  /** 向量化 返回 OpenAI embeddings 形状 网关内部已断言 1024 维 */
  @Post('embeddings')
  async embeddings(@Body() body: unknown, @Res() res: Response): Promise<void> {
    const parsed = EmbeddingsSchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const req = parsed.data

    const texts = Array.isArray(req.input) ? req.input : [req.input]
    const vectors = await this.gateway.embedMany(texts)

    res.json({
      object: 'list',
      data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
      model: req.model,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    })
  }

  /** 流式输出 OpenAI chunk 格式 每个 delta 一条 data 结束时补 usage 与 [DONE] */
  private async streamCompletion(
    res: Response,
    opts: { alias: string; messages: ModelMessage[]; temperature?: number; includeUsage: boolean },
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)

    const stream = await this.gateway.chatStream({
      messages: opts.messages,
      alias: opts.alias,
      temperature: opts.temperature,
    })

    try {
      for await (const delta of stream.textStream) {
        if (!delta) continue
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: opts.alias,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          })}\n\n`,
        )
      }

      // 流结束 取用量 若请求带 include_usage 补末块 usage
      const usage = await stream.usage
      // 流式 usage 运行时附带 costCny（未进契约 UsageInfo）此处窄化读取
      const costCny = (usage as unknown as { costCny?: number }).costCny ?? 0
      if (opts.includeUsage) {
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: opts.alias,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: this.toUsage(usage, costCny),
          })}\n\n`,
        )
      }

      res.write('data: [DONE]\n\n')
      res.end()
    } catch (e) {
      // 流中途失败 已无法降级 尽力告知客户端后结束
      const message = e instanceof Error ? e.message : 'stream error'
      res.write(`data: ${JSON.stringify({ error: { message, type: 'stream_error' } })}\n\n`)
      res.end()
    }
  }

  /** 转 OpenAI usage 形状 cost_cny 为网关附加字段 客户端可忽略 */
  private toUsage(usage: UsageInfo, costCny: number): Record<string, number> {
    return {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
      cost_cny: costCny,
    }
  }
}
