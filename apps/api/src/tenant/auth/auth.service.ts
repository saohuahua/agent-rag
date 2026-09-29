import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { PrismaService } from '../../prisma/prisma.service'
import { EnvService } from '../../config/env.service'
import { signJwt } from './jwt'
import { hashPassword, verifyPassword } from './password'
import { TenantConflictError, TenantUnauthorizedError } from '../tenant.errors'
import type { MemberRole } from '../../generated/prisma/enums'

/** JWT 有效期 24 小时（规格 §4.2） */
const TTL_SECONDS = 24 * 60 * 60

/** 注册入参 */
export interface RegisterInput {
  email: string
  password: string
  displayName?: string
  enterpriseName: string
}

/** 登录入参 */
export interface LoginInput {
  email: string
  password: string
}

/** 认证结果：token 给控制器写 cookie 其余给前端展示 不含口令散列 */
export interface AuthResult {
  token: string
  user: { id: number; email: string; displayName: string }
  member: { id: number; enterpriseId: number; role: string }
  enterprise: { id: number; name: string; slug: string }
}

/**
 * 认证服务：注册/登录/JWT 签发
 * 注册在无租户上下文下运行（合法） 事务里建 User+Enterprise+根部门+OWNER Member
 * 登录在无租户上下文下查用户全量成员身份 选 OWNER 优先签发令牌
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  /**
   * 注册：一次事务建企业全链 返回令牌
   * 为什么事务：User/Enterprise/Department/Member 四者要么全成要么全滚 否则半截企业无法登录
   * @param input 注册信息
   * @returns 认证结果（含 token）
   */
  async register(input: RegisterInput): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase()

    // 邮箱唯一 冲突返回 409
    const existing = await this.prisma.user.findUnique({ where: { email } })
    if (existing) {
      throw new TenantConflictError(`email already registered: ${email}`)
    }

    const passwordHash = hashPassword(input.password)
    const displayName = input.displayName?.trim() || email.split('@')[0] || '用户'
    // slug 随机 用于邀请路径 唯一性靠随机量级保证 冲突概率可忽略
    const slug = `e-${randomUUID().slice(0, 8)}`

    const result = await this.prisma.$transaction(async tx => {
      const user = await tx.user.create({ data: { email, passwordHash, displayName } })
      const enterprise = await tx.enterprise.create({ data: { name: input.enterpriseName.trim(), slug } })

      // 根部门物化路径含自身 前后带斜杠（规格 §4.2 path='/<id>/'）
      const rootDept = await tx.department.create({
        data: { enterpriseId: enterprise.id, name: '总部', path: `/${enterprise.id}/` },
      })

      // 注册者即 OWNER 挂在根部门下
      const member = await tx.member.create({
        data: { enterpriseId: enterprise.id, userId: user.id, role: 'OWNER', departmentId: rootDept.id },
      })

      return { user, enterprise, member }
    })

    const token = this.issueToken(result.user.id, result.member.id, result.member.enterpriseId, result.member.role)
    return {
      token,
      user: { id: result.user.id, email: result.user.email, displayName: result.user.displayName },
      member: { id: result.member.id, enterpriseId: result.member.enterpriseId, role: result.member.role },
      enterprise: { id: result.enterprise.id, name: result.enterprise.name, slug: result.enterprise.slug },
    }
  }

  /**
   * 登录：口令校验通过后 从用户全量成员身份里挑 OWNER 优先的一个签发令牌
   * @param input 登录信息
   * @returns 认证结果（含 token）
   */
  async login(input: LoginInput): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase()

    // 无上下文直通 按邮箱查人
    const user = await this.prisma.user.findUnique({ where: { email } })
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw new TenantUnauthorizedError('invalid email or password')
    }

    // 一个自然人可属多企业 列出全部活跃身份 选 OWNER 优先
    const members = await this.prisma.member.findMany({
      where: { userId: user.id, status: 'ACTIVE' },
      orderBy: { id: 'asc' },
      include: { enterprise: true },
    })
    const member = members.find(m => m.role === 'OWNER') ?? members[0]
    if (!member) {
      throw new TenantUnauthorizedError('no active membership')
    }

    const token = this.issueToken(user.id, member.id, member.enterpriseId, member.role)
    return {
      token,
      user: { id: user.id, email: user.email, displayName: user.displayName },
      member: { id: member.id, enterpriseId: member.enterpriseId, role: member.role },
      enterprise: { id: member.enterprise.id, name: member.enterprise.name, slug: member.enterprise.slug },
    }
  }

  /**
   * 当前登录用户资料（/auth/me） 经 member.guard 进入上下文后调用
   * @param userId 自然人 id（guard 从 JWT sub 解出）
   * @param memberId 成员 id（guard 写入上下文）
   * @returns 用户/成员/企业三元组（不含口令）
   */
  async me(userId: number, memberId: number): Promise<Omit<AuthResult, 'token'>> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, userId },
      include: { user: true, enterprise: true },
    })
    if (!member) {
      throw new TenantUnauthorizedError('membership gone')
    }
    return {
      user: { id: member.user.id, email: member.user.email, displayName: member.user.displayName },
      member: { id: member.id, enterpriseId: member.enterpriseId, role: member.role },
      enterprise: { id: member.enterprise.id, name: member.enterprise.name, slug: member.enterprise.slug },
    }
  }

  /** 签发 JWT 载荷对齐 TenantCtx（sub 额外存 userId 供邀请接受定位自然人） */
  private issueToken(userId: number, memberId: number, enterpriseId: number, role: MemberRole): string {
    return signJwt({ sub: userId, memberId, enterpriseId, role }, this.env.JWT_SECRET, TTL_SECONDS)
  }
}
