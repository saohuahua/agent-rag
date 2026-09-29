import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { TemplateService } from './template.service'
import { MemberGuard } from '../member.guard'
import { RoleGuard } from '../role.guard'
import { Roles } from '../roles.decorator'

const DraftSchema = z.object({
  slug: z.string().trim().min(1).max(80),
  name: z.string().trim().max(100).optional(),
  description: z.string().max(2000).optional(),
  systemPrompt: z.string().max(20000).optional(),
  avatar: z.string().max(500).optional(),
})

const UpdateSchema = z.object({
  name: z.string().trim().max(100).optional(),
  description: z.string().max(2000).optional(),
  systemPrompt: z.string().max(20000).optional(),
  avatar: z.string().max(500).optional(),
})

const RejectSchema = z.object({ reviewNote: z.string().trim().min(1).max(2000) })

const BindingsSchema = z.object({
  skillBindings: z.array(z.object({
    skillKey: z.string().min(1),
    configJson: z.record(z.string(), z.unknown()).optional(),
    order: z.number().int().min(0).optional(),
  })).optional(),
  kbBindings: z.array(z.object({
    datasetId: z.number().int().positive(),
    kbMode: z.enum(['INJECT', 'TOOL', 'BOTH']),
  })).optional(),
})

/**
 * 岗位模板控制器（平台级资源 审核流由 ADMIN 操作）
 * 全部需登录；publish/reject/archive 需 ADMIN（OWNER 层级含）
 */
@Controller('templates')
@UseGuards(MemberGuard)
export class TemplateController {
  constructor(private readonly service: TemplateService) {}

  /** 起草模板（自动下一版本） */
  @Post('draft')
  draft(@Body() body: unknown) {
    return this.service.draft(DraftSchema.parse(body))
  }

  /** 提交审核 */
  @Post(':id/submit')
  submit(@Param('id', ParseIntPipe) id: number) {
    return this.service.submit(id)
  }

  /** 审核通过（上架） */
  @Post(':id/publish')
  @UseGuards(RoleGuard)
  @Roles('ADMIN')
  publish(@Param('id', ParseIntPipe) id: number) {
    return this.service.publish(id)
  }

  /** 驳回 */
  @Post(':id/reject')
  @UseGuards(RoleGuard)
  @Roles('ADMIN')
  reject(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    return this.service.reject(id, RejectSchema.parse(body).reviewNote)
  }

  /** 归档 */
  @Post(':id/archive')
  @UseGuards(RoleGuard)
  @Roles('ADMIN')
  archive(@Param('id', ParseIntPipe) id: number) {
    return this.service.archive(id)
  }

  /** 编辑（仅 DRAFT/REJECTED） */
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    return this.service.update(id, UpdateSchema.parse(body))
  }

  /** 设置技能/知识库绑定（仅 DRAFT/REJECTED） */
  @Put(':id/bindings')
  setBindings(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    return this.service.setBindings(id, BindingsSchema.parse(body))
  }

  /** 列表 可 ?slug= 过滤 */
  @Get()
  list(@Query('slug') slug?: string) {
    return this.service.list(slug)
  }

  /** 详情（含绑定） */
  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.service.getWithBindings(id)
  }
}
