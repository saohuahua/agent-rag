import { Module } from '@nestjs/common'
import { SkillExecutorRegistry } from './skill-executor'

/**
 * [桩] 技能执行器模块（任务 H 填充：八个 SkillDef + 三类执行器）
 */
@Module({
  providers: [SkillExecutorRegistry],
  exports: [SkillExecutorRegistry],
})
export class SkillsModule {}
