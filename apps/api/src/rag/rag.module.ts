import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { RetrievalService } from './retrieval.service'
import { KbController } from './kb.controller'
import { IngestProcessor, DOC_INGEST_QUEUE } from './ingest.processor'
import { PdfParser } from './parser/pdf-parser'
import { DocxParser } from './parser/docx-parser'
import { ChunkRepository } from './chunk.repository'

/**
 * 知识库 RAG 模块
 * 上传/入库 worker/双索引检索/检索测试台
 * 队列连接复用 app.module 的 BullModule.forRootAsync 这里只 registerQueue 不建连接
 */
@Module({
  imports: [BullModule.registerQueue({ name: DOC_INGEST_QUEUE })],
  controllers: [KbController],
  providers: [RetrievalService, IngestProcessor, PdfParser, DocxParser, ChunkRepository],
  exports: [RetrievalService],
})
export class RagModule {}
