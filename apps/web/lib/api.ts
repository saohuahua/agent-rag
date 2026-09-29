/**
 * 前端统一 fetch 封装
 * mock 开关 NEXT_PUBLIC_API_MOCK=true 时 base 指向 Next 自带 route handler
 * 关闭后切到真实 Nest 后端（NEXT_PUBLIC_API_BASE_URL 默认 http://localhost:3002）
 * 统一携带 cookie（credentials include 真实后端 JWT HttpOnly cookie 自动带上）
 * 统一 401 跳登录 错误归一化成 ApiError 英文 message 可搜索
 */

/** mock 开关 构建期内联 后端就绪后改 .env.local 为 false */
const MOCK = process.env.NEXT_PUBLIC_API_MOCK === 'true'

/** 真实后端基地址 mock 模式下忽略 */
const REMOTE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3002'

/** 当前生效的 API 基地址 */
export const API_BASE = MOCK ? '/api/mock' : REMOTE

/**
 * 拼完整 URL 去掉多余斜杠
 * @param path 以 / 开头的相对路径
 */
export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
}

/** 归一化后的请求错误 带 HTTP 状态码 英文 message */
export class ApiError extends Error {
  /** HTTP 状态码 0 表示网络层失败（fetch reject） */
  code: number

  constructor(message: string, code: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/** 后端可能返回的 body 形状 统一取值 */
function extractMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (typeof obj.message === 'string' && obj.message) return obj.message
    if (Array.isArray(obj.message)) {
      // Nest 校验失败返回 message 数组 取第一条
      const first = obj.message[0]
      if (typeof first === 'string') return first
    }
    if (typeof obj.error === 'string' && obj.error) return obj.error
  }
  return fallback
}

/** 401 统一处理 避免重复跳转 */
function handleUnauthorized(): void {
  if (typeof window === 'undefined') return
  if (window.location.pathname === '/login') return
  window.location.assign('/login')
}

/**
 * 核心请求函数 解析 JSON 并归一化错误
 * @param path 相对路径 如 /auth/me
 * @param init 透传给 fetch 的选项 自动补 credentials 与 JSON 头
 * @throws ApiError 非 2xx 或网络失败时抛出
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      ...init,
      credentials: 'include',
      headers: {
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    })
  } catch (e) {
    throw new ApiError(`network error: ${e instanceof Error ? e.message : 'unknown'}`, 0)
  }

  // 401 未登录统一跳转
  if (res.status === 401) {
    handleUnauthorized()
    throw new ApiError('unauthorized', 401)
  }

  // 204 无 body 直接返回空对象
  if (res.status === 204) {
    return {} as T
  }

  let data: unknown = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    throw new ApiError(extractMessage(data, `request failed with status ${res.status}`), res.status)
  }

  return data as T
}

/** GET 便捷封装 */
export function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' })
}

/** POST 便捷封装 自动 JSON 序列化 body */
export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
}

/** PATCH 便捷封装 */
export function patch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) })
}

/** DELETE 便捷封装 */
export function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' })
}

/**
 * useChat transport 指向的 turn 流地址
 * mock 模式指向 /api/mock/sessions/:id/turns 真实模式指向 3002 后端
 */
export function chatTurnUrl(sessionId: number): string {
  return apiUrl(`/sessions/${sessionId}/turns`)
}

/** 事件时间线 EventSource 地址 */
export function eventsUrl(sessionId: number): string {
  return apiUrl(`/sessions/${sessionId}/events`)
}

/** 文档上传 multipart 走原始 fetch 不带 JSON 头 单独封装 */
export async function uploadDoc<T>(datasetId: number, file: File): Promise<T> {
  const form = new FormData()
  form.append('file', file)

  let res: Response
  try {
    res = await fetch(apiUrl(`/kb/datasets/${datasetId}/docs`), {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
  } catch (e) {
    throw new ApiError(`network error: ${e instanceof Error ? e.message : 'unknown'}`, 0)
  }

  if (res.status === 401) {
    handleUnauthorized()
    throw new ApiError('unauthorized', 401)
  }

  let data: unknown = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    throw new ApiError(extractMessage(data, `upload failed with status ${res.status}`), res.status)
  }
  return data as T
}
