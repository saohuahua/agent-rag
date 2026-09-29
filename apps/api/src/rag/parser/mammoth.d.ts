/**
 * mammoth 模块类型声明（无官方 @types 包 本地最小声明）
 * 只声明本模块用到的两个导出 其余字段按需留 any 由调用方收窄
 */
declare module 'mammoth' {
  /** 转换结果 含文档消息（警告/错误） */
  export interface MammothResult {
    value: string
    messages: Array<{ type: string; message: string }>
  }

  /** 转换入参 支持 Buffer 输入 */
  export interface MammothInput {
    buffer: Buffer
  }

  /** docx 转 HTML */
  export function convertToHtml(input: MammothInput): Promise<MammothResult>

  /** docx 转纯文本 */
  export function extractRawText(input: MammothInput): Promise<MammothResult>
}
