import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'

/** 全局 Prisma 模块：所有任务直接注入 PrismaService */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
