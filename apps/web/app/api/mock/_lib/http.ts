/**
 * mock route handler 共用响应辅助
 * 统一 JSON 响应与 401/404/400 错误形状 错误 message 英文可搜索
 */

import type { MockMember } from './store'
import { currentMember } from './store'

/** JSON 响应 */
export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
}

/** 未登录 401 */
export function unauthorized(): Response {
  return json({ message: 'unauthorized' }, { status: 401 })
}

/** 资源不存在 404 */
export function notFound(): Response {
  return json({ message: 'not found' }, { status: 404 })
}

/** 参数错误 400 */
export function badRequest(message: string): Response {
  return json({ message }, { status: 400 })
}

/**
 * 登录态守卫 已登录返回成员 未登录返回 401 Response
 * 调用方用 instanceof Response 判断是否需要提前 return
 */
export function requireMember(req: Request): MockMember | Response {
  const member = currentMember(req)
  if (!member) return unauthorized()
  return member
}

/** 管理员守卫 非 OWNER/ADMIN 返回 403 */
export function requireAdmin(req: Request): MockMember | Response {
  const member = requireMember(req)
  if (member instanceof Response) return member
  if (member.role !== 'OWNER' && member.role !== 'ADMIN') {
    return json({ message: 'forbidden admin role required' }, { status: 403 })
  }
  return member
}
