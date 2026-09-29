import { describe, expect, it } from 'vitest'
import { signJwt, verifyJwt } from '../../src/tenant/auth/jwt'
import { hashPassword, verifyPassword } from '../../src/tenant/auth/password'

const SECRET = 'test-secret'

describe('纯 HMAC JWT 签发与校验', () => {
  it('签发后可校验还原载荷', () => {
    const token = signJwt({ sub: 7, memberId: 8, enterpriseId: 9, role: 'OWNER' }, SECRET, 3600)
    const payload = verifyJwt(token, SECRET)
    expect(payload).toMatchObject({ sub: 7, memberId: 8, enterpriseId: 9, role: 'OWNER' })
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('过期 token 被拒绝', () => {
    const token = signJwt({ sub: 1, memberId: 2, enterpriseId: 3, role: 'MEMBER' }, SECRET, -10)
    expect(verifyJwt(token, SECRET)).toBeNull()
  })

  it('篡改载荷或密钥不符被拒绝', () => {
    const token = signJwt({ sub: 1, memberId: 2, enterpriseId: 3, role: 'MEMBER' }, SECRET, 3600)
    expect(verifyJwt(token, 'wrong-secret')).toBeNull()

    const [h, b, s] = token.split('.')
    const tampered = `${h}.${Buffer.from(JSON.stringify({ sub: 999 })).toString('base64url')}.${s}`
    expect(verifyJwt(tampered, SECRET)).toBeNull()
  })

  it('格式非法返回 null 不抛', () => {
    expect(verifyJwt('not-a-jwt', SECRET)).toBeNull()
    expect(verifyJwt('a.b', SECRET)).toBeNull()
  })
})

describe('scrypt 口令散列', () => {
  it('正确口令通过 错误口令拒绝', () => {
    const stored = hashPassword('secret123')
    expect(stored).toContain(':')
    expect(verifyPassword('secret123', stored)).toBe(true)
    expect(verifyPassword('wrong', stored)).toBe(false)
  })

  it('同口令两次散列不同（盐随机）且各自可校验', () => {
    const a = hashPassword('same-password')
    const b = hashPassword('same-password')
    expect(a).not.toBe(b)
    expect(verifyPassword('same-password', a)).toBe(true)
    expect(verifyPassword('same-password', b)).toBe(true)
  })
})
