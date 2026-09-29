import * as fs from 'node:fs'
import * as path from 'node:path'

/** 题型 与 corpus/golden/rag-eval.jsonl 的 type 字段一致 */
export type GoldenType = 'single_hop' | 'multi_hop' | 'numeric' | 'refusal_trap'

/** golden 题目最小形态 评测只消费 question/goldKeywords/type/refuse */
export interface GoldenQuestion {
  id: string
  type: GoldenType
  question: string
  goldKeywords: string[]
  goldAnswer: string
  refuse?: boolean
}

/**
 * 加载 golden 测试集（corpus/golden/rag-eval.jsonl 每行一题）
 * 为什么读 jsonl 而非 json：评测入口（30-评测/01 §1）指定 jsonl
 * @param corpusDir corpus 根目录 相对仓库根
 * @returns 题目数组 保持文件顺序
 */
export function loadGolden(corpusDir: string): GoldenQuestion[] {
  const file = path.join(corpusDir, 'golden', 'rag-eval.jsonl')
  const text = fs.readFileSync(file, 'utf8')

  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line): GoldenQuestion => {
      const raw = JSON.parse(line) as {
        id: string
        type: string
        question: string
        goldKeywords: string[]
        goldAnswer: string
        refuse?: boolean
      }
      return {
        id: raw.id,
        type: raw.type as GoldenType,
        question: raw.question,
        goldKeywords: raw.goldKeywords ?? [],
        goldAnswer: raw.goldAnswer ?? '',
        refuse: raw.refuse ?? false,
      }
    })
}
