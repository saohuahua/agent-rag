import { json, badRequest } from '../../_lib/http'
import { db, buildCookie, MOCK_COOKIE, toMe } from '../../_lib/store'

/**
 * 登录 校验邮箱密码后写登录 cookie 返回 me
 * 演示账号 owner1@demo.com / owner2@demo.com 密码均 123456
 */
export async function POST(req: Request): Promise<Response> {
  let body: { email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return badRequest('invalid json body')
  }

  const email = body.email?.trim().toLowerCase()
  const password = body.password

  if (!email || !password) return badRequest('email and password required')

  const member = db.members.find((m) => m.email === email)
  if (!member || member.password !== password) {
    return badRequest('invalid email or password')
  }

  const me = toMe(member)
  return json(me, {
    headers: {
      'Set-Cookie': `${MOCK_COOKIE}=${encodeURIComponent(buildCookie(member.enterpriseId, member.id, member.role))}; Path=/; SameSite=Lax; HttpOnly`,
    },
  })
}
