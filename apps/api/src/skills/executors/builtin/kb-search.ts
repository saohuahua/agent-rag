import { Injectable } from '@nestjs/common'
import { z } from 'zod'
import { RetrievalService } from '../../../rag/retrieval.service'
import { SkillInputError } from '../../errors'
import type { SkillCtx, SkillResult } from '../../skill-executor'
import type { KbSearchInput } from '../../defs/kb-search'

/** 片段摘要截断长度 太长会挤占上下文窗口 截断后仍保留来源可回查原文 */
const CONTENT_TRUNCATE = 300

/** configJson 契约 模板绑定本技能时可注入 datasetId 限定检索范围 */
const CONFIG_SCHEMA = z
  .object({ datasetId: z.number().int().positive().optional() })
  .nullable()

/**
 * kb_search 执行器 直调 RetrievalService 契约（双路混合检索）
 * 不做 LLM 摘要 命中内容原样截断返回 保证证据可信
 */
@Injectable()
export class KbSearchExecutor {
  constructor(private readonly retrieval: RetrievalService) {}

  /**
   * 执行知识库检索
   * @param input 已过 zod 校验的检索入参
   * @param ctx 技能执行上下文 取租户 id 限定企业数据隔离
   */
  async run(input: KbSearchInput, ctx: SkillCtx): Promise<SkillResult> {
    // 租户上下文必须有 否则无法做企业级数据隔离
    const enterpriseId = ctx.ctx?.enterpriseId
    if (!enterpriseId) {
      throw new SkillInputError('kb_search requires tenant context')
    }

    // configJson 注入 datasetId 限定检索范围 解析失败或缺失则检索整个企业知识库
    // 注：RetrievalService 契约当前只按 enterpriseId 隔离 dataset 级过滤待 B 任务契约扩展
    const cfg = CONFIG_SCHEMA.safeParse(ctx.configJson)
    const datasetId = cfg.success ? cfg.data?.datasetId ?? null : null

    const hits = await this.retrieval.hybridSearch({
      enterpriseId,
      query: input.query,
      topK: input.topK ?? 8,
    })

    // 截断内容 保留来源与融合分 供 LLM 判断相关性与前端可视化
    const summarized = hits.map((h) => ({
      chunkId: h.chunkId,
      docId: h.docId,
      headingPath: h.headingPath ?? null,
      rrfScore: h.rrfScore,
      content: h.content.slice(0, CONTENT_TRUNCATE),
    }))

    return {
      output: { hits: summarized, count: summarized.length, datasetId },
      summary:
        summarized.length > 0
          ? `检索到 ${summarized.length} 条相关知识片段`
          : '未检索到相关知识片段',
    }
  }
}
