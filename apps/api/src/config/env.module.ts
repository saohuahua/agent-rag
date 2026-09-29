import { Global, Module } from '@nestjs/common'
import { EnvService } from './env.service'

/** 全局环境模块：动态模块（BullMQ forRootAsync 等）与所有业务模块都能注入 EnvService */
@Global()
@Module({
  providers: [EnvService],
  exports: [EnvService],
})
export class EnvModule {}
