/**
 * 前端类型出口 全部从 @agent-rag/shared 导入（见 10-骨架/04 §7）
 * 页面与组件统一从这里取类型 不直接 import shared 便于未来替换
 */
export * from '@agent-rag/shared'

import type { ExecutionEventItem } from '@agent-rag/shared'

/**
 * 时间线按 turn 分组的视图模型
 * 一个 turn 从 TURN_START 到 TURN_END 归为一组 便于渲染分段
 */
export interface TimelineGroup {
  /** 该组首事件的类型 通常 TURN_START */
  kind: string
  /** 组内事件 按发生顺序 */
  events: ExecutionEventItem[]
}

/** 聊天输入框的 @ 提及解析结果 */
export interface MentionParse {
  /** 去掉 @ 前缀后的剩余文本 */
  text: string
  /** 被 @ 的员工 displayName 未匹配到则为 null */
  employeeName: string | null
}
