import { SetMetadata } from '@nestjs/common'
import type { MemberRole } from '../generated/prisma/enums'

/** 角色元数据键 role.guard 读取 */
export const ROLES_KEY = 'tenant_roles'

/**
 * 声明端点所需角色 @Roles('ADMIN') 配合 RoleGuard 使用
 * 角色层级 OWNER ⊇ ADMIN ⊇ MEMBER 即 @Roles('ADMIN') 允许 OWNER 与 ADMIN
 * @param roles 允许的角色列表
 */
export const Roles = (...roles: MemberRole[]) => SetMetadata(ROLES_KEY, roles)
