import { Injectable } from '@nestjs/common'
import mammoth from 'mammoth'
import type { TextBlock } from './types'

/**
 * DOCX 解析器 mammoth 封装
 * mammoth 输出 HTML（h1-h6 p table li）这里做窄集标签提取
 * 为什么不做完整 HTML 解析：mammoth 只产出窄集标签 正则扫描足够 免引入解析器依赖
 */
@Injectable()
export class DocxParser {
  /**
   * 解析 DOCX 字节为有序文本块
   * 标题维护层级路径 段落/表格继承最近的标题路径
   * @param buffer DOCX 原始字节
   * @returns 按文档序的文本块
   */
  async parse(buffer: Buffer): Promise<TextBlock[]> {
    const { value } = await mammoth.convertToHtml({ buffer })
    return parseHtml(value)
  }
}

/** 解码 HTML 实体 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 剥离行内标签 只留文本 */
function stripInline(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

/** 匹配块级标签 依次为 h1-h6 p li table 非贪婪到对应闭合标签 */
const BLOCK_RE = /<(h[1-6]|p|li|table)\b[^>]*>([\s\S]*?)<\/\1>/gi

/**
 * 把 mammoth HTML 解析为有序文本块
 * 标题路径维护：hN 截断到 N-1 层后覆盖第 N 层 同级覆盖深层压栈
 * 导出供单测直测（纯函数 不依赖 zip 解包）
 * @param html mammoth 输出的 HTML
 */
export function parseHtml(html: string): TextBlock[] {
  const blocks: TextBlock[] = []
  const headingPath: string[] = []

  let m: RegExpExecArray | null
  while ((m = BLOCK_RE.exec(html))) {
    const tag = m[1]!.toLowerCase()
    const inner = decodeEntities(stripInline(m[2]!)).trim()

    if (tag === 'table') {
      // 表格整块原子 继承当前标题路径
      const text = serializeTableInner(m[2]!)
      if (text) {
        blocks.push({ text, page: null, headingPath: headingPath.length ? [...headingPath] : null, isTable: true })
      }
      continue
    }

    if (tag === 'p' || tag === 'li') {
      if (inner) {
        blocks.push({ text: inner, page: null, headingPath: headingPath.length ? [...headingPath] : null, isTable: false })
      }
      continue
    }

    // h1-h6 标题 自身也作为可检索文本块 父路径为进入该标题前的路径
    if (inner) {
      const level = Number(tag[1]!)
      const parent = [...headingPath]

      // 截断到 level-1 层 再写第 level 层 实现同级覆盖
      headingPath.length = level - 1
      headingPath[level - 1] = inner

      blocks.push({ text: inner, page: null, headingPath: parent.length ? parent : null, isTable: false })
    }
  }

  return blocks
}

/** 表格内部行序列化 行内单元格 | 分隔 行间换行 */
function serializeTableInner(inner: string): string {
  const rows: string[][] = []
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let tr: RegExpExecArray | null
  while ((tr = trRe.exec(inner))) {
    const cells: string[] = []
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
    let cell: RegExpExecArray | null
    while ((cell = cellRe.exec(tr[1]!))) {
      cells.push(decodeEntities(stripInline(cell[1]!)).trim())
    }
    if (cells.length) rows.push(cells)
  }
  return rows.map(r => r.join(' | ')).join('\n').trim()
}
