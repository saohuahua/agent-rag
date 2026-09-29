你是「任务 B：知识库 RAG」的执行会话。工作目录 D:\project\agent-rag。任务 0 已完成。本任务与其他任务并行执行。

# 必读文档
1. docs/10-工程骨架/03-代码规范.md（强制）
2. docs/20-模块实现规格/02-知识库RAG.md（★完整规格）
3. docs/10-工程骨架/04-模块间契约.md（§4 RetrievalService 契约签名不变）
4. docs/10-工程骨架/02-Prisma7与数据库迁移.md §5（raw SQL 统一口径+ef_search 坑）

# 你的任务（独占 apps/api/src/rag/**）
按规格 §4 实现：kb.controller（上传/状态/检索测试台）、retrieval.service（hybridSearch 双路+RRF+降级）、ingest.processor（BullMQ doc-ingest：解析→分块→分词→向量化→事务入库）、parser 三件（pdf-parse/mammoth/quality 乱码探测）、chunker（600±100 字符重叠 100 表格原子）、tokenizer（jieba cutForSearch+tsquery 特殊符清洗带单测）、chunk.repository（raw SQL 收口+租户过滤）。

# 边界
- 只写 apps/api/src/rag/**；embedding 调用经 gateway 契约（桩抛 NOT_IMPLEMENTED 时你的单测 mock GatewayService；真实验收等 A 完成后让用户跑一次）
- 不 pnpm add（pdf-parse/mammoth/jieba 任务 0 已装）；不 commit/push

# 验收（规格 §4.7）
上传真实 PDF 全状态流转；检索语义问法+术语问法各命中；EXPLAIN 走 HNSW/GIN（截图留证）；§4.6 测试全绿（含 RRF 手算一致、降级单路、幂等、租户过滤）

# 完成动作
报告 docs/08-阶段总结/B-RAG-报告.md；验收命令给用户；契约变更提案如有。
