import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * 口令散列（scrypt + 随机盐）零新依赖
 * 为什么不用 bcrypt：未在任务 0 依赖白名单内 且 Node 内置 scrypt 是公认的内存困难 KDF 够用
 * 存储格式 salt:hash 均为 hex 便于拆分校验
 */

/** scrypt 输出字节数 64 足够抗碰撞 */
const KEY_LEN = 64

/**
 * 散列口令
 * @param password 明文口令
 * @returns 形如 salt:hash 的存储串
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, KEY_LEN).toString('hex')
  return `${salt}:${hash}`
}

/**
 * 校验明文口令与存储串是否匹配
 * @param password 明文口令
 * @param stored salt:hash 存储串
 * @returns 匹配返回 true
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  const salt = parts[0]
  const hash = parts[1]
  if (!salt || !hash) return false

  // 重算 hash 恒定时间比较 防时序侧信道
  const calc = scryptSync(password, salt, KEY_LEN)
  const a = Buffer.from(hash, 'hex')
  return a.length === calc.length && timingSafeEqual(a, calc)
}
