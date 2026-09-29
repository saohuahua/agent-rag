/** 质量探测结果 */
export interface QualityCheck {
  /** 通过与否 */
  ok: boolean
  /** 不通过原因 供 parseError 记录 */
  reason?: string
}

/** 判定字符是否可打印 覆盖 CJK 中文标点 全角符号 ASCII 字母数字 */
function isPrintable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0

  // CJK 统一表意文字 4E00-9FFF
  if (code >= 0x4e00 && code <= 0x9fff) return true
  // CJK 扩展 A 3400-4DBF 与兼容区 F900-FAFF
  if (code >= 0x3400 && code <= 0x4dbf) return true
  if (code >= 0xf900 && code <= 0xfaff) return true
  // 中文标点 3000-303F 与全角符号 FF00-FFEF
  if (code >= 0x3000 && code <= 0x303f) return true
  if (code >= 0xff00 && code <= 0xffef) return true
  // ASCII 数字 0-9 字母 A-Z a-z
  if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return true

  return false
}

/**
 * 乱码/空文本层探测
 * 为什么探测而不硬解：中文 PDF 可能缺 ToUnicode 映射 解出全是乱码或空白
 * 继续入库只会污染检索 直接终态 OCR_NEEDED 交给人工 OCR 流程
 * @param text 全文
 * @param minChars 最低字符数 默认 200
 * @returns 质量结果
 */
export function checkQuality(text: string, minChars = 200): QualityCheck {
  // 统计非空白字符
  const nonSpace = Array.from(text).filter(ch => !/\s/.test(ch))

  if (nonSpace.length < minChars) {
    return { ok: false, reason: `text too short: ${nonSpace.length} chars < ${minChars}` }
  }

  const printable = nonSpace.filter(ch => isPrintable(ch)).length
  const rate = printable / nonSpace.length

  if (rate < 0.6) {
    return { ok: false, reason: `CJK printable rate ${(rate * 100).toFixed(1)}% < 60%` }
  }

  return { ok: true }
}
