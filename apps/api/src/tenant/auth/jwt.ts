import { createHmac, timingSafeEqual } from 'node:crypto'
import type { MemberRole } from '../../generated/prisma/enums'

/**
 * 纯 HMAC 自签 JWT（HS256）零新依赖
 * 为什么不用 jose/jsonwebtoken：规格允许「纯 HMAC 自签避开新依赖」并行会话 pnpm add 会损坏 lockfile（10-骨架/01）
 * 为什么 HMAC 而非 RSA：单服务签发与校验 对称密钥够用 JWT_SECRET 走 EnvService（默认 dev 值 P4 换生产值）
 * 校验用 timingSafeEqual 防时序侧信道
 */

/** JWT 载荷：sub 是 User.id 用于邀请接受时定位自然人 其余三字段进 TenantCtx */
export interface JwtPayload {
  sub: number
  memberId: number
  enterpriseId: number
  role: MemberRole
  iat?: number
  exp?: number
}

/** base64url 编码（JWT 专用无填充 与 Buffer 内置 base64url 一致） */
function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

/**
 * 签发 HS256 JWT
 * @param payload 业务载荷（sub/memberId/enterpriseId/role）
 * @param secret 签名密钥
 * @param ttlSeconds 有效期秒
 * @returns JWT 字符串（header.payload.signature）
 */
export function signJwt(payload: JwtPayload, secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8'))
  const body = b64url(Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }), 'utf8'))

  // 签名覆盖 header.body 三部分不可拆分
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

/**
 * 校验并解出 JWT 载荷 失败返回 null（不抛 由调用方转 401）
 * @param token JWT 字符串
 * @param secret 签名密钥
 * @returns 载荷 或 null（格式错/签名错/过期）
 */
export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.')
  const header = parts[0]
  const body = parts[1]
  const sig = parts[2]
  if (!header || !body || !sig) return null

  // 重算签名 与收到的签名等长恒定时间比较
  const expect = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expect)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  // 解析载荷并校验 exp 已过期则拒绝
  let payload: JwtPayload
  try {
    // JSON.parse 返回 any 结构即 JwtPayload 安全转（签名已验 内容自签可信）
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtPayload
  } catch {
    return null
  }
  if (payload.exp !== undefined && Math.floor(Date.now() / 1000) > payload.exp) return null
  return payload
}
