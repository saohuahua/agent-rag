import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { z } from 'zod'
import { InvitationService } from './invitation.service'
import { MemberGuard } from './member.guard'
import { TenantUnauthorizedError } from './tenant.errors'

const AcceptSchema = z.object({ token: z.string().min(1) })

/**
 * 邀请接受控制器：登录用户凭 token 加入目标企业
 * 需登录（member.guard 提供 userId）但接受动作跨企业 服务层清空上下文执行
 */
@Controller('invitations')
export class InvitationController {
  constructor(private readonly service: InvitationService) {}

  /** 接受邀请 */
  @Post('accept')
  @UseGuards(MemberGuard)
  async accept(@Body() body: unknown, @Req() req: Request) {
    const input = AcceptSchema.parse(body)
    const userId = req.userId
    if (userId === undefined) {
      throw new TenantUnauthorizedError('not authenticated')
    }
    return this.service.accept(input.token, userId)
  }
}
