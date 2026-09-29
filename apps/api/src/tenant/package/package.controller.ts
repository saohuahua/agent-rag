import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { PackageService } from './package.service'
import { MemberGuard } from '../member.guard'
import { RoleGuard } from '../role.guard'
import { Roles } from '../roles.decorator'

const CreatePackageSchema = z.object({
  slug: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).optional(),
})

const CreateVersionSchema = z.object({
  items: z.array(z.object({
    templateSlug: z.string().min(1).max(80),
    templateVersion: z.number().int().positive(),
  })).min(1),
})

const RejectSchema = z.object({ reviewNote: z.string().trim().min(1).max(2000) })

/**
 * 订阅包控制器（平台级商品壳 审核流 ADMIN 操作）
 */
@Controller('packages')
@UseGuards(MemberGuard)
export class PackageController {
  constructor(private readonly service: PackageService) {}

  /** 建包壳 */
  @Post()
  create(@Body() body: unknown) {
    return this.service.create(CreatePackageSchema.parse(body))
  }

  /** 开新版本（含模板清单） */
  @Post(':id/versions')
  createVersion(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    const input = CreateVersionSchema.parse(body)
    return this.service.createVersion(id, input.items)
  }

  /** 提交审核 */
  @Post('versions/:versionId/submit')
  submit(@Param('versionId', ParseIntPipe) versionId: number) {
    return this.service.submitVersion(versionId)
  }

  /** 发布版本（上架） */
  @Post('versions/:versionId/publish')
  @UseGuards(RoleGuard)
  @Roles('ADMIN')
  publish(@Param('versionId', ParseIntPipe) versionId: number) {
    return this.service.publishVersion(versionId)
  }

  /** 驳回版本 */
  @Post('versions/:versionId/reject')
  @UseGuards(RoleGuard)
  @Roles('ADMIN')
  reject(@Param('versionId', ParseIntPipe) versionId: number, @Body() body: unknown) {
    return this.service.rejectVersion(versionId, RejectSchema.parse(body).reviewNote)
  }

  /** 包列表 */
  @Get()
  list() {
    return this.service.listPackages()
  }

  /** 包版本列表（含清单项） */
  @Get(':id/versions')
  versions(@Param('id', ParseIntPipe) id: number) {
    return this.service.listVersions(id)
  }
}
