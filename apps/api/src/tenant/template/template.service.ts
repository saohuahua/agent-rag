import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { EnterpriseContextService } from '../enterprise-context.service'
import { AuditService } from '../audit.service'
import { TenantInvalidStateError, TenantNotFoundError } from '../tenant.errors'
import { TemplateStatus } from '../../generated/prisma/enums'
import type { Prisma } from '../../generated/prisma/client'

/** 模板草稿入参 */
export interface TemplateDraftInput {
  slug: string
  name?: string
  description?: string
  systemPrompt?: string
  avatar?: string
}

/** 技能/知识库绑定入参 */
export interface TemplateBindingsInput {
  skillBindings?: Array<{ skillKey: string; configJson?: unknown; order?: number }>
  kbBindings?: Array<{ datasetId: number; kbMode: 'INJECT' | 'TOOL' | 'BOTH' }>
}

/**
 * 岗位模板状态机（平台级 无 enterpriseId 全平台共享）
 * 流转：DRAFT → PENDING_REVIEW → PUBLISHED[终态不可变] / REJECTED(可改再提交)
 *      PUBLISHED → ARCHIVED
 * 为什么 PUBLISHED 不可变：模板=岗位行为真相 服务中客户后半夜改 prompt 是事故 新行为只能新版本行（规格 §4.4）
 * 为什么 REJECTED 同版本可改：从未发布过 无客户在用 无需新版本（规格 §4.4 设计决策）
 */
@Injectable()
export class TemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: EnterpriseContextService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 起草模板（自动开下一版本号 从旧版复制起点）
   * @param input 草稿内容 slug 决定版本族
   * @returns 新建模板行
   */
  async draft(input: TemplateDraftInput) {
    const ctxTenant = this.ctx.require()
    const slug = input.slug.trim()

    // 同一 slug 已发布过 则新版本从旧版复制起步（版本+1）
    const latest = await this.prisma.employeeTemplate.findFirst({
      where: { slug },
      orderBy: { version: 'desc' },
    })
    const version = (latest?.version ?? 0) + 1

    return this.prisma.employeeTemplate.create({
      data: {
        slug,
        version,
        name: input.name?.trim() || latest?.name || slug,
        description: input.description ?? latest?.description ?? '',
        systemPrompt: input.systemPrompt ?? latest?.systemPrompt ?? '',
        avatar: input.avatar ?? latest?.avatar,
        status: TemplateStatus.DRAFT,
        createdBy: ctxTenant.memberId,
      },
    })
  }

  /** 提交审核 DRAFT/REJECTED → PENDING_REVIEW */
  async submit(id: number) {
    const tpl = await this.mustGet(id)
    if (tpl.status !== TemplateStatus.DRAFT && tpl.status !== TemplateStatus.REJECTED) {
      throw new TenantInvalidStateError(`cannot submit template in status ${tpl.status}`)
    }
    const updated = await this.prisma.employeeTemplate.update({ where: { id }, data: { status: TemplateStatus.PENDING_REVIEW } })
    await this.audit.write({ action: 'TEMPLATE_SUBMIT', targetType: 'EmployeeTemplate', targetId: id, after: { version: tpl.version } })
    return updated
  }

  /** 审核通过 PENDING_REVIEW → PUBLISHED（终态不可变）平台级动作 审计无企业归属 */
  async publish(id: number) {
    const tpl = await this.mustGet(id)
    if (tpl.status !== TemplateStatus.PENDING_REVIEW) {
      throw new TenantInvalidStateError(`cannot publish template in status ${tpl.status}`)
    }
    const updated = await this.prisma.employeeTemplate.update({
      where: { id },
      data: { status: TemplateStatus.PUBLISHED, publishedAt: new Date() },
    })
    await this.audit.write({
      action: 'TEMPLATE_PUBLISH',
      targetType: 'EmployeeTemplate',
      targetId: id,
      before: { status: tpl.status },
      after: { status: TemplateStatus.PUBLISHED, version: tpl.version },
      enterpriseId: null,
    })
    return updated
  }

  /** 驳回 PENDING_REVIEW → REJECTED 记审核意见 */
  async reject(id: number, reviewNote: string) {
    const tpl = await this.mustGet(id)
    if (tpl.status !== TemplateStatus.PENDING_REVIEW) {
      throw new TenantInvalidStateError(`cannot reject template in status ${tpl.status}`)
    }
    const updated = await this.prisma.employeeTemplate.update({
      where: { id },
      data: { status: TemplateStatus.REJECTED, reviewNote },
    })
    await this.audit.write({
      action: 'TEMPLATE_REJECT',
      targetType: 'EmployeeTemplate',
      targetId: id,
      before: { status: tpl.status },
      after: { status: TemplateStatus.REJECTED, reviewNote },
      enterpriseId: null,
    })
    return updated
  }

  /** 归档 PUBLISHED → ARCHIVED */
  async archive(id: number) {
    const tpl = await this.mustGet(id)
    if (tpl.status !== TemplateStatus.PUBLISHED) {
      throw new TenantInvalidStateError(`cannot archive template in status ${tpl.status}`)
    }
    return this.prisma.employeeTemplate.update({ where: { id }, data: { status: TemplateStatus.ARCHIVED } })
  }

  /**
   * 编辑模板（仅 DRAFT/REJECTED）PUBLISHED/ARCHIVED 拒绝（不可变语义）
   * @param id 模板 id
   * @param fields 可改字段
   */
  async update(id: number, fields: Partial<Pick<TemplateDraftInput, 'name' | 'description' | 'systemPrompt' | 'avatar'>>) {
    const tpl = await this.mustGet(id)
    if (tpl.status !== TemplateStatus.DRAFT && tpl.status !== TemplateStatus.REJECTED) {
      throw new TenantInvalidStateError(`template in ${tpl.status} is immutable create a new version instead`)
    }
    return this.prisma.employeeTemplate.update({
      where: { id },
      data: {
        ...(fields.name !== undefined ? { name: fields.name.trim() } : {}),
        ...(fields.description !== undefined ? { description: fields.description } : {}),
        ...(fields.systemPrompt !== undefined ? { systemPrompt: fields.systemPrompt } : {}),
        ...(fields.avatar !== undefined ? { avatar: fields.avatar } : {}),
      },
    })
  }

  /**
   * 设置技能/知识库绑定（仅 DRAFT/REJECTED）
   * 绑定整体替换 先删后建 保证与提交版本一致
   */
  async setBindings(id: number, input: TemplateBindingsInput) {
    const tpl = await this.mustGet(id)
    if (tpl.status !== TemplateStatus.DRAFT && tpl.status !== TemplateStatus.REJECTED) {
      throw new TenantInvalidStateError(`template in ${tpl.status} bindings are locked`)
    }

    await this.prisma.$transaction(async tx => {
      if (input.skillBindings) {
        await tx.templateSkillBinding.deleteMany({ where: { templateId: id } })
        for (const b of input.skillBindings) {
          await tx.templateSkillBinding.create({
            // configJson 是调用方传入的 JSON 可序列化对象 转 InputJsonValue 安全 省略用 undefined
            data: { templateId: id, skillKey: b.skillKey, configJson: b.configJson === undefined ? undefined : (b.configJson as Prisma.InputJsonValue), order: b.order ?? 0 },
          })
        }
      }
      if (input.kbBindings) {
        await tx.templateKbBinding.deleteMany({ where: { templateId: id } })
        for (const b of input.kbBindings) {
          await tx.templateKbBinding.create({ data: { templateId: id, datasetId: b.datasetId, kbMode: b.kbMode } })
        }
      }
    })

    return this.getWithBindings(id)
  }

  /** 列表 按 slug+version 排序 */
  async list(slug?: string) {
    return this.prisma.employeeTemplate.findMany({
      where: slug ? { slug } : {},
      orderBy: [{ slug: 'asc' }, { version: 'desc' }],
    })
  }

  /** 详情（含绑定） */
  async getWithBindings(id: number) {
    const tpl = await this.mustGet(id)
    const [skillBindings, kbBindings] = await Promise.all([
      this.prisma.templateSkillBinding.findMany({ where: { templateId: id }, orderBy: { order: 'asc' } }),
      this.prisma.templateKbBinding.findMany({ where: { templateId: id } }),
    ])
    return { ...tpl, skillBindings, kbBindings }
  }

  /** 按 id 取模板 不存在 404 */
  private async mustGet(id: number) {
    const tpl = await this.prisma.employeeTemplate.findFirst({ where: { id } })
    if (!tpl) {
      throw new TenantNotFoundError('template not found')
    }
    return tpl
  }
}
