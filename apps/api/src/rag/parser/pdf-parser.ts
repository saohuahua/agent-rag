import { Injectable } from '@nestjs/common'
import { PDFParse } from 'pdf-parse'
import type { TextBlock } from './types'

/**
 * PDF 解析器 pdf-parse 2.x 封装
 * 产出有序 TextBlock 段落（按空行切）+ 表格（getTable 整表原子）
 */
@Injectable()
export class PdfParser {
  /**
   * 解析 PDF 字节为有序文本块
   * 为什么 getText 与 getTable 分开两次调用：pdf-parse 的表格检测与文本提取是两套管线
   * 表格整块序列化为一个块 避免分块时把行列拆散 见 20-规格/02 §3 表格原子
   * @param buffer PDF 原始字节
   * @returns 按页序的文本块
   */
  async parse(buffer: Buffer): Promise<TextBlock[]> {
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const textResult = await parser.getText()

      // 表格检测为尽力而为 无表格的 PDF 可能抛错 忽略不影响正文
      let tableResult
      try {
        tableResult = await parser.getTable()
      } catch {
        tableResult = null
      }

      const blocks: TextBlock[] = []

      for (const page of textResult.pages) {
        // 每页文本按空行切段落 保留页码
        for (const p of splitParagraphs(page.text)) {
          blocks.push({ text: p, page: page.num, headingPath: null, isTable: false })
        }

        // 该页表格整块追加为原子块（pdf-parse 不提供 heading 结构 标题路径为 null）
        const pageTables = tableResult?.pages.find(t => t.num === page.num)
        for (const table of pageTables?.tables ?? []) {
          const text = serializeTable(table)
          if (text) blocks.push({ text, page: page.num, headingPath: null, isTable: true })
        }
      }

      return blocks
    } finally {
      await parser.destroy()
    }
  }
}

/** 按空行切段落 过滤纯空白行 */
function splitParagraphs(pageText: string): string[] {
  return pageText
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
}

/** 表格序列化为可读文本 行内单元格以 | 分隔 行间换行 供检索与展示 */
function serializeTable(table: string[][]): string {
  return table.map(row => row.join(' | ')).join('\n').trim()
}
