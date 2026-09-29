import { Module } from '@nestjs/common'
import { RetrievalService } from './retrieval.service'

/**
 * [桩] 知识库 RAG 模块（任务 B 填充：上传/入库 worker/双索引/检索测试台）
 */
@Module({
  providers: [RetrievalService],
  exports: [RetrievalService],
})
export class RagModule {}
