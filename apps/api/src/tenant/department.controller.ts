import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { DepartmentService } from './department.service'
import { MemberGuard } from './member.guard'
import { RoleGuard } from './role.guard'
import { Roles } from './roles.decorator'

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  parentId: z.number().int().positive().nullish(),
})

const RenameSchema = z.object({ name: z.string().trim().min(1).max(100) })

/**
 * 部门物化路径树控制器
 * 创建/改名/删除限 ADMIN（OWNER 层级含）读取全员
 */
@Controller('departments')
@UseGuards(MemberGuard)
export class DepartmentController {
  constructor(private readonly service: DepartmentService) {}

  /** 创建部门（可挂父） */
  @Post()
  @UseGuards(RoleGuard)
  @Roles('ADMIN')
  create(@Body() body: unknown) {
    const input = CreateSchema.parse(body)
    return this.service.create(input.name, input.parentId ?? undefined)
  }

  /** 平铺列表 */
  @Get()
  list() {
    return this.service.list()
  }

  /** 嵌套树 */
  @Get('tree')
  tree() {
    return this.service.tree()
  }

  /** 改部门名（path 不动） */
  @Patch(':id')
  @UseGuards(RoleGuard)
  @Roles('ADMIN')
  rename(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    return this.service.rename(id, RenameSchema.parse(body).name)
  }

  /** 删除部门（非空拒绝） */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RoleGuard)
  @Roles('ADMIN')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.service.remove(id)
  }
}
