import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict'

/**
 * 应用层分词 tokenizer
 * 为什么中文必须应用层分词：PG 默认 parser 把连续中文当一个 token
 * simple 配置只做 lowercase 分词责任上移应用层（jieba）见 20-规格/02 §5
 */

/** tsquery 语法符正则 出现在 token 里会被解析为运算符 必须剔除 */
const TSQUERY_SPECIALS = /[&|!():'"*^\\]/g

/** jieba 实例惰性单例 默认词典约 5MB 进程内只加载一次 */
let jieba: Jieba | null = null

/** 惰性加载 jieba 实例（withDict 载入默认词典） */
function getJieba(): Jieba {
  if (!jieba) jieba = Jieba.withDict(dict)
  return jieba
}

/**
 * 清洗单个分词结果
 * 规则：剔除 tsquery 语法符 & | ! ( ) : ' " * ^ \ 与空白 空串返回 null
 * 为什么保留字母数字与连字符：中文术语常含数字（如 7天 3C）连字符用于英文词组
 * @param raw jieba 切出的原始 token
 * @returns 清洗后 token 空串返回 null 由调用方过滤
 */
export function cleanToken(raw: string): string | null {
  const t = raw.replace(TSQUERY_SPECIALS, '').trim()
  if (!t) return null
  if (/^\s*$/.test(t)) return null
  return t
}

/**
 * 分词入口 cutForSearch + 清洗 + 去重
 * 为什么 cutForSearch：搜索引擎模式 长词进一步切细 兼顾精确与召回
 * @param text 原文
 * @returns 清洗去重后的 token 列表 保持首次出现顺序
 */
export function tokenize(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of getJieba().cutForSearch(text, true)) {
    const t = cleanToken(raw)
    if (t === null) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/**
 * token 列表拼 OR 查询表达式
 * 为什么 OR 而非 AND：AND 过严容易空结果 OR 宽容匹配再用 ts_rank 排序
 * @param tokens 已清洗 token
 * @returns 'a | b | c' 空列表返回空串
 */
export function toTsquery(tokens: string[]): string {
  return tokens.join(' | ')
}

/**
 * token 列表拼空格串 供 to_tsvector('simple', ...) 使用
 * simple 配置只 lowercase 分词责任已上移应用层（jieba）见文件头注释
 * @param tokens 已清洗 token
 * @returns 空格连接的 token 串
 */
export function toTsvectorInput(tokens: string[]): string {
  return tokens.join(' ')
}
