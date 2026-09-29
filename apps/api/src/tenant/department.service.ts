import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { EnterpriseContextService } from './enterprise-context.service'
import { TenantConflictError, TenantNotFoundError } from './tenant.errors'

/** 部门树节点（含 children 的嵌套结构） */
export interface DeptNode {
  id: number
  name: string
  parentId: number | null
  path: string
  sortOrder: number
  children: DeptNode[]
}

/**
 * 部门物化路径树服务
 * 为什么物化路径：读多写少 一个 LIKE 查子树；path 用 id 不用名 改名不动结构（规格 §5）
 * 本模块只支持创建/改名/删除 不支持移动（换父）——移动要整棵子树重算 path 是路径方案的已知弱点
 * 子树查询走 ORM startsWith 扩展同时注入 enterpriseId 双重隔离
 */
@Injectable()
export class DepartmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: EnterpriseContextService,
  ) {}

  /**
   * 创建部门（可挂父）事务内先建行拿到自增 id 再回写物化路径
   * @param name 部门名
   * @param parentId 父部门 id 缺省为根
   * @returns 创建后的部门
   */
  async create(name: string, parentId?: number): Promise<DeptNode> {
    const ctxTenant = this.ctx.require()
    let parentPath = ''
    if (parentId !== undefined && parentId !== null) {
      const parent = await this.prisma.department.findFirst({ where: { id: parentId } })
      if (!parent) {
        throw new TenantNotFoundError('parent department not found')
      }
      parentPath = parent.path
    }

    const created = await this.prisma.$transaction(async tx => {
      const dept = await tx.department.create({
        data: { enterpriseId: ctxTenant.enterpriseId, name: name.trim(), parentId: parentId ?? null, path: '' },
      })
      // 物化路径含自身 前后带斜杠
      const path = parentId ? `${parentPath}${dept.id}/` : `/${dept.id}/`
      return tx.department.update({ where: { id: dept.id }, data: { path } })
    })

    return this.toNode(created)
  }

  /** 全部门平铺列表 按路径升序（同层相邻） */
  async list(): Promise<DeptNode[]> {
    const rows = await this.prisma.department.findMany({ orderBy: { path: 'asc' } })
    return rows.map(r => this.toNode(r))
  }

  /** 部门树（嵌套）根为 parentId=null 的节点 */
  async tree(): Promise<DeptNode[]> {
    const nodes = await this.list()
    return buildTree(nodes)
  }

  /**
   * 改部门名 path 不动（path 用 id 而非名 规避了路径方案的更新弱点）
   * @param id 部门 id
   * @param name 新名字
   */
  async rename(id: number, name: string): Promise<DeptNode> {
    const updated = await this.prisma.department.update({ where: { id }, data: { name: name.trim() } })
    return this.toNode(updated)
  }

  /**
   * 删除部门 有子部门或仍有成员则拒绝（409）防悬挂
   * @param id 部门 id
   */
  async remove(id: number): Promise<void> {
    const dept = await this.prisma.department.findFirst({ where: { id }, include: { _count: { select: { children: true, members: true } } } })
    if (!dept) {
      throw new TenantNotFoundError('department not found')
    }
    if (dept._count.children > 0 || dept._count.members > 0) {
      throw new TenantConflictError('department not empty (children or members exist)')
    }
    await this.prisma.department.delete({ where: { id } })
  }

  /** 把 Prisma 行转为节点（children 由 tree 组装） */
  private toNode(r: { id: number; name: string; parentId: number | null; path: string; sortOrder: number }): DeptNode {
    return { id: r.id, name: r.name, parentId: r.parentId, path: r.path, sortOrder: r.sortOrder, children: [] }
  }
}

/** 平铺节点按 parentId 组装成嵌套树 */
function buildTree(nodes: DeptNode[]): DeptNode[] {
  const map = new Map<number, DeptNode>()
  for (const n of nodes) map.set(n.id, n)
  const roots: DeptNode[] = []
  for (const n of nodes) {
    if (n.parentId !== null && map.has(n.parentId)) {
      map.get(n.parentId)!.children.push(n)
    } else {
      roots.push(n)
    }
  }
  return roots
}
