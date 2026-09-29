import type { TextBlock } from './parser/types'

/** 分块结果 待分词向量化 */
export interface ChunkDraft {
  /** 块正文 */
  content: string
  /** 页码 PDF 有值 DOCX 为 null */
  page: number | null
  /** 标题路径 序列化为 ' / ' 连接 无则 null */
  headingPath: string | null
}

/** 目标块字符数 */
const TARGET = 600

/** 相邻块重叠字符数 */
const OVERLAP = 100

/**
 * 结构感知分块
 * 目标 600 中文字符 相邻块重叠 100 表格整块原子不拆
 * 为什么 600：bge-m3 8k 窗口下 600 字≈300-400 token 召回粒度与上下文成本平衡
 * @param blocks 解析器输出的有序文本块
 * @returns 分块草稿 顺序保持文档阅读序
 */
export function chunkBlocks(blocks: TextBlock[]): ChunkDraft[] {
  const out: ChunkDraft[] = []

  // 当前累积缓冲与起始上下文（首个字符的页码与标题）
  let buf = ''
  let bufPage: number | null = null
  let bufHeading: string | null = null

  /** 落块 空块跳过 */
  const emit = (content: string, page: number | null, heading: string | null): void => {
    const trimmed = content.trim()
    if (trimmed) out.push({ content: trimmed, page, headingPath: heading })
  }

  for (const block of blocks) {
    const heading = block.headingPath && block.headingPath.length ? block.headingPath.join(' / ') : null

    // 表格整块原子 先落掉未满 600 的缓冲 再整表成块 不并入缓冲也不拆
    if (block.isTable) {
      emit(buf, bufPage, bufHeading)
      emit(`[表格] ${block.text}`, block.page, heading)
      buf = ''
      bufPage = null
      bufHeading = null
      continue
    }

    // 缓冲为空时记录起始上下文
    if (!buf) {
      bufPage = block.page
      bufHeading = heading
    }

    // 追加文本 块间空格分隔
    buf = buf ? `${buf} ${block.text}` : block.text

    // 达到目标即落块 保留 100 重叠 注意重叠段沿用起始上下文（近似 100 字内的页边界忽略）
    while (buf.length >= TARGET) {
      emit(buf.slice(0, TARGET), bufPage, bufHeading)
      buf = buf.slice(TARGET - OVERLAP)
    }
  }

  // 收尾 剩余不足 600 也落块
  emit(buf, bufPage, bufHeading)

  return out
}
