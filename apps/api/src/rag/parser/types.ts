/**
 * 解析器公共类型
 * pdf-parser 与 docx-parser 都输出该结构 分块器只依赖这个结构
 */

/** 解析器输出的单个文本块 段落或整表 顺序保持文档阅读序 */
export interface TextBlock {
  /** 块文本 表格已序列化为可读文本 */
  text: string
  /** PDF 页码 1 起 DOCX 为 null */
  page: number | null
  /** 最近的标题路径 如 ['第三章', '退款规则'] 无标题则 null */
  headingPath: string[] | null
  /** 是否表格块 表格整块原子 分块时不参与段落合并 */
  isTable: boolean
}
