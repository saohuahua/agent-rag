import { json } from '../../_lib/http'
import { MOCK_COOKIE } from '../../_lib/store'

/** 登出 清空登录 cookie */
export async function POST(): Promise<Response> {
  return json(
    { ok: true },
    {
      headers: { 'Set-Cookie': `${MOCK_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax` },
    },
  )
}
