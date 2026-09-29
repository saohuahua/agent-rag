# 20-02 · 模块规格：知识库 RAG（M2 · B 任务）

> 五段式：业务问题 → 原理 → 选型对比 → 实现规格 → 面试深挖区。

## 1. 业务问题

几百篇平台规则/政策文档，人记不住、Ctrl+F 语义搜不到（「买错了能退吗」≠「7天无理由」）。需求：上传文档→自动解析入库→问什么都能答，且 **embedding 服务挂了问答不能停**（客服停摆=业务事故）。

## 2. 原理

- **双路召回**：语义路（embedding 向量余弦近邻，解决同义不同词）+ 词法路（BM25 类关键词排序，解决精确术语如「扣非净利润」「禁限售目录」）——两路互补是中文 RAG 胜负手；
- **RRF 融合**：`score(d) = Σ 1/(60 + rank_i(d))`，只用排名不用分数（两路分数量纲不可比），k=60 为业界默认（Elasticsearch 同款）；
- **降级**：向量路失败/不健康→跳过该路，RRF 退化为单路排名，链路不断；
- **异步入库**：上传即返回，BullMQ worker 慢慢解析（PDF 解析分钟级不能阻塞 HTTP）。

## 3. 选型对比

| 决策 | 选了 | 没选 | 一句话 |
|---|---|---|---|
| 向量库 | pgvector（单库） | Qdrant/Milvus | 与业务数据同库同事务；个人项目规模（万级 chunk）PG 毫无压力 |
| 词法 | jieba 应用层分词 + tsvector/simple + GIN | zhparser / pgroonga | 免自定义镜像免 Windows 编译；ts_rank 非 BM25 但 RRF 只用排名（如实写文档） |
| 融合 | 应用层 RRF | SQL 层融合 | 降级语义天然；计算量极小 |
| 解析 | pdf-parse 2.x + mammoth | docling(Python) / MinerU | TS 生态内最优；中文 PDF 乱码风险→探测分流 OCR_NEEDED 不硬解 |

## 4. 实现规格

### 4.1 文件清单（B 任务独占 `apps/api/src/rag/`）

```
rag/
├─ rag.module.ts               // 注册 doc-ingest 队列/worker/controller
├─ kb.controller.ts            // 上传/状态/检索测试台 API
├─ retrieval.service.ts        // 契约实现 hybridSearch
├─ ingest.processor.ts         // BullMQ WorkerHost 解析入库
├─ parser/
│  ├─ pdf-parser.ts            // pdf-parse 封装（段落+表格）
│  ├─ docx-parser.ts           // mammoth 封装
│  └─ quality.ts               // 乱码/空文本层探测 → OCR_NEEDED
├─ chunker.ts                  // 结构感知分块
├─ tokenizer.ts                // jieba cutForSearch + tsquery 特殊符清洗
└─ chunk.repository.ts         // TenantScopedRepository：chunk 的 raw SQL 全收口于此
```

### 4.2 HTTP API 契约

| 端点 | 说明 |
|---|---|
| `POST /kb/datasets` | `{name, description?}` 建数据集（租户） |
| `GET /kb/datasets` | 列表（含 doc 数量统计） |
| `POST /kb/datasets/:id/docs` | multipart 上传 PDF/DOCX；校验 mime/大小(≤20MB)；checksum 去重（409）；建 KnowledgeDoc(QUEUED) + 入队；立即返回 `{docId, status}` |
| `GET /kb/docs/:id` | 状态轮询 `{status, chunkCount, parseError?}`（前端上传进度） |
| `POST /kb/search` | `{query, datasetId?, topK?}` 检索测试台：返回 hit 数组**含每路 rank 与 rrfScore**（可视化双路） |

### 4.3 入库流水线（ingest.processor）

```
job: { docId }（jobId=docId 幂等 attempts=3 backoff exponential 3000ms）
1 解析：按 mime 分发 pdf-parser/docx-parser
  - quality.ts 检查：CJK 可打印率 < 60% 或全文 < 200 字符 → status=OCR_NEEDED 终态 return
2 分块（chunker.ts）：
  - pdf-parse 的 paragraph 序列上做结构感知：目标块 600 中文字符 重叠 100
  - 表格(getTable)整块成 chunk content='[表格] '+行列文本
  - headingPath 取最近的标题序列（pdf-parse 有 heading 结构则用 无则 null）
3 分词（tokenizer.ts）：tokens = jieba.cutForSearch(chunk.content)
4 向量化：gateway.embedMany(chunks)（32/批内聚 调用方无感）——失败则 job 抛错走 BullMQ 重试
5 入库（chunk.repository.ts 单事务）：
  INSERT INTO knowledge_chunks (doc_id, seq, content, page, heading_path, token_count, embedding, tsv)
  VALUES (..., $embedding::vector, to_tsvector('simple', $tokens))
  —— 逐行或 COPY 批量均可 但必须一个事务 全成功或全回滚
6 更新 doc status=INDEXED chunkCount=n；job.updateProgress 分阶段 10/50/90/100
```

### 4.4 hybridSearch 规格（retrieval.service.ts）

```typescript
// 两路并行 Promise.allSettled
// 向量路：qvec = await gateway.embedMany([query])  → chunk.repository.vectorSearch(enterpriseId, qvec, limit=50)
//   SQL: SET LOCAL hnsw.ef_search=100; SELECT id, doc_id, ... FROM knowledge_chunks
//        WHERE enterpriseId 过滤（JOIN doc） ORDER BY embedding <=> $1::vector LIMIT 50
// 词法路：tokens = tokenizer(query) → chunk.repository.lexicalSearch(enterpriseId, tokens, limit=50)
//   SQL: ... WHERE tsv @@ to_tsquery('simple', $orExpr) ORDER BY ts_rank(tsv, to_tsquery(...)) DESC LIMIT 50
//   orExpr = tokens.join(' | ')（OR 宽容 避免 AND 过严空结果）
// channel='auto'：embeddingHealthy()=false 或向量路 rejected → 只用词法路 rank（记录 DEGRADE 事件到日志）
// RRF 融合：score = Σ 有该路的 1/(60+rank)；按 score desc 取 topK
```

**tokenizer 清洗规则**（带单测）：token 过滤 tsquery 语法符 `& | ! ( ) : ' " * ^ \` 与空串、单字符纯数字/字母可选保留；规则写在代码注释里。

### 4.5 降级验收（本模块的灵魂）

- 手动把 embedding route 禁用（或 mock gateway.embedMany reject）→ `POST /kb/search` 仍返回纯词法结果，hit 的 vectorRank 全 undefined，日志含 `[DEGRADE] embedding unavailable, fallback to lexical`；
- 集成任务 J 会做真实断网演练。

### 4.6 测试清单

- 分块：600±100 字符、重叠 100、表格原子块、headingPath 正确
- 分词清洗：特殊符剔除、空 token、OR 表达式拼装
- RRF 纯函数：构造两路排名断言融合序（与 k=60 手算一致）
- 降级：allSettled 一路 reject → 单路结果
- 幂等：同 docId 重跑 job 不产生重复 chunk（事务+unique(docId,seq) upsert 语义）
- 隔离：租户 A 的数据 B 查不到（**必须**，D 完成后补真实上下文测试，先以显式 enterpriseId 参数测）

### 4.7 验收

- 上传一份真实电商规则 PDF → 状态流转 UPLOADED→QUEUED→PARSING→INDEXED（前端可见进度）
- `POST /kb/search` 语义问法与术语问法都能命中（人工挑 5 个查询验证）
- `EXPLAIN ANALYZE` 向量查询走 HNSW 索引、词法走 GIN（截图进 30-评测）
- 评测三组消融数字产出（见 30-评测方案——评测脚本在 B 或 J 任务实现，跑批在 J）

## 5. 面试深挖区

- 「为什么中文必须应用层分词？」→ PG 默认 parser 把连续中文当一个 token，tsvector 对中文失效；simple 配置只做 lowercase，分词责任上移应用层（jieba）
- 「ts_rank 不是 BM25 你知道吗？」→ 知道，如实写文档；RRF 只用**排名**所以两路评分函数的差异被屏蔽——这是选 RRF 而非加权分数融合的核心原因
- 「chunk 多大为什么？」→ 600 字符≈300-400 token：bge-m3 8k 窗口下的召回粒度与上下文成本平衡；有评测就报数字
- 「表格怎么处理？」→ 整表原子 chunk + caption 关联；行级定位留给生成期（表级召回→LLM 从整表读数）
- 「为什么检索要 JOIN doc 过滤租户而不是 chunk 上加 enterpriseId？」→ schema 里 chunk 有 enterpriseId 冗余吗？——有（KnowledgeDoc 冗余了 enterpriseId 到 chunk 的 JOIN 路径）实现以 schema 为准：chunk 无该列，JOIN doc 过滤；此选择写进 chunk.repository 注释
