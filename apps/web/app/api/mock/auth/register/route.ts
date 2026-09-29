import { json, badRequest } from '../../_lib/http'
import { db, buildCookie, MOCK_COOKIE, toMe, nextIdFor } from '../../_lib/store'

/**
 * 注册 事务语义 建企业根部门 + 建 OWNER 成员 + 写登录 cookie
 * 新企业无订阅无员工无数据集 从空工作台开始
 */
export async function POST(req: Request): Promise<Response> {
  let body: { email?: string; password?: string; enterpriseName?: string }
  try {
    body = await req.json()
  } catch {
    return badRequest('invalid json body')
  }

  const email = body.email?.trim().toLowerCase()
  const password = body.password
  const enterpriseName = body.enterpriseName?.trim()

  if (!email || !email.includes('@')) return badRequest('email required and must be valid')
  if (!password || password.length < 6) return badRequest('password must be at least 6 characters')
  if (!enterpriseName) return badRequest('enterpriseName required')

  if (db.members.some((m) => m.email === email)) {
    return badRequest('email already registered')
  }

  const enterpriseId = nextIdFor('enterprise')
  const rootDeptId = nextIdFor('dept')
  const memberId = nextIdFor('member')

  db.departments.push({
    id: rootDeptId,
    enterpriseId,
    parentId: null,
    name: enterpriseName,
    path: `/${rootDeptId}/`,
    sortOrder: 0,
  })

  db.members.push({
    id: memberId,
    enterpriseId,
    email,
    password,
    displayName: enterpriseName + '管理员',
    role: 'OWNER',
    departmentId: rootDeptId,
    status: 'ACTIVE',
  })

  const me = toMe(db.members.find((m) => m.id === memberId)!)
  return json(me, {
    headers: {
      'Set-Cookie': `${MOCK_COOKIE}=${encodeURIComponent(buildCookie(enterpriseId, memberId, 'OWNER'))}; Path=/; SameSite=Lax; HttpOnly`,
    },
  })
}
