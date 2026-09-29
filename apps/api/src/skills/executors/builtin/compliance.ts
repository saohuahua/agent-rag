import { Injectable } from '@nestjs/common'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type { SkillCtx, SkillResult } from '../../skill-executor'
import type { ComplianceCheckInput } from '../../defs/compliance'

/** 严重度英文取值 与 words.json 对齐 */
export type Severity = 'severe' | 'high' | 'medium'

/** 单条命中违规 规则名即 words.json 的分组键 */
export interface Violation {
  word: string
  rule: string
  severity: Severity
}

/** 词表文件结构 按规则名分组的词条 */
const WORDS_FILE_SCHEMA = z.object({
  words: z.record(
    z.string(),
    z.array(
      z.object({
        word: z.string().min(1),
        severity: z.enum(['severe', 'high', 'medium']),
      }),
    ),
  ),
})

/** 词表分组类型 */
export type WordGroups = z.infer<typeof WORDS_FILE_SCHEMA>['words']

/** 严重度排序权重 severe 最重 */
const SEVERITY_RANK: Record<Severity, number> = { severe: 0, high: 1, medium: 2 }

/**
 * 词表候选路径 兼容不同启动目录
 * 第一个是仓库根 第二个是从 apps/api 目录启动时的相对位置
 */
const WORDS_CANDIDATES = [
  path.resolve(process.cwd(), 'corpus/compliance/words.json'),
  path.resolve(process.cwd(), '../../corpus/compliance/words.json'),
]

/**
 * 读取词表文件 按候选路径逐个尝试 命中第一个存在的文件
 * 为什么用候选路径而非硬编码：单测与 nest start 的 cwd 不同 硬编码会读不到
 * @param filePath 指定路径 单测注入 fixture 用 缺省用候选路径
 */
export function loadWords(filePath?: string): WordGroups {
  const target = filePath ?? WORDS_CANDIDATES.find((p) => fs.existsSync(p))
  if (!target) {
    throw new Error('compliance words.json not found under corpus/compliance')
  }

  const raw = fs.readFileSync(target, 'utf8')
  const parsed = WORDS_FILE_SCHEMA.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    throw new Error(`compliance words.json invalid: ${parsed.error.message}`)
  }
  return parsed.data.words
}

/**
 * 确定性词表匹配 纯函数 便于单测
 * 为什么用 contains 而非分词：中文无天然词边界 且词表含单字「最」这类绝对化语素 子串命中即违规
 * 去重：同一词只记一条 词表存在重复条目（如「最高级」「最佳」出现两次）
 * @param title 商品标题
 * @param category 商品类目 类目本身也参与匹配 如类目为「处方药」会命中违禁词
 * @param description 商品描述 可空
 * @param words 词表分组
 */
export function matchViolations(
  title: string,
  category: string,
  description: string | undefined,
  words: WordGroups,
): Violation[] {
  // 大小写折叠后匹配 兼容 NO.1 TOP.1 这类英文词条
  const text = `${title} ${category} ${description ?? ''}`.toLowerCase()

  const seen = new Set<string>()
  const out: Violation[] = []

  for (const [rule, entries] of Object.entries(words)) {
    for (const e of entries) {
      const needle = e.word.toLowerCase()
      if (seen.has(needle)) continue
      if (text.includes(needle)) {
        seen.add(needle)
        out.push({ word: e.word, rule, severity: e.severity })
      }
    }
  }

  // severe 优先 同严重度按词排序 输出稳定可复现
  out.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.word.localeCompare(b.word),
  )
  return out
}

/** 严重度中文标签 摘要展示用 */
const SEVERITY_LABEL: Record<Severity, string> = { severe: '严重', high: '高', medium: '中' }

/**
 * compliance_check 执行器 确定性词表引擎 不消耗 LLM
 */
@Injectable()
export class ComplianceExecutor {
  /** 词表懒加载缓存 进程内只读一次 */
  private wordsCache: WordGroups | null = null

  /**
   * 执行合规检查
   * @param input 已过 zod 校验的检查入参
   */
  async run(input: ComplianceCheckInput, _ctx: SkillCtx): Promise<SkillResult> {
    if (!this.wordsCache) {
      this.wordsCache = loadWords()
    }

    const violations = matchViolations(input.title, input.category, input.description, this.wordsCache)
    const passed = violations.length === 0
    const top = violations[0]?.severity

    return {
      output: { violations, passed },
      summary: passed
        ? '合规检查通过 未发现违禁词'
        : `发现 ${violations.length} 处违规 最高严重度 ${top ? SEVERITY_LABEL[top] : '未知'}`,
    }
  }
}
