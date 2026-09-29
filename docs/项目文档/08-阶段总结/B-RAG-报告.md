# 任务 B · M2 知识库 RAG 报告（2026-09-29）

> 并行执行会话。本任务独占 `apps/api/src/rag/**`，依赖网关（A 已完成 真实现可直调）+ 租户上下文（D 并行中）。检索契约签名（10-骨架/04 §4）保持不变。

## 1. 交付物清单（对照规格 §4.1 文件清单）

| 文件 | 职责 | 状态 |
|---|---|---|
| `rag/rag.module.ts` | 注册 doc-ingest 队列/worker/controller | ✅ |
| `rag/kb.controller.ts` | 上传/状态/检索测试台（5 端点） | ✅ |
| `rag/retrieval.service.ts` | 契约实现 `hybridSearch` 双路+RRF+降级 | ✅ |
| `rag/ingest.processor.ts` | BullMQ `WorkerHost` 解析→分块→分词→向量化→事务入库 | ✅ |
| `rag/parser/pdf-parser.ts` | pdf-parse 2.x 封装（段落+getTable 表格原子） | ✅ |
| `rag/parser/docx-parser.ts` | mammoth 封装（窄集 HTML 提取标题/段落/表格） | ✅ |
| `rag/parser/quality.ts` | CJK 可打印率<60% 或 <200 字 → OCR_NEEDED | ✅ |
| `rag/chunker.ts` | 600±100 字符 重叠 100 表格原子 | ✅ |
| `rag/tokenizer.ts` | jieba cutForSearch + tsquery 清洗 + OR 拼装 | ✅ |
| `rag/chunk.repository.ts` | chunk 的 raw SQL 全收口 + JOIN doc 租户过滤 | ✅ |
| `rag/parser/types.ts` `rag/parser/mammoth.d.ts` `rag/storage.ts` | 解析公共类型 / mammoth 类型声明 / 本地落盘收口 | ✅（清单外必要增量） |

## 2. 与文档计划的偏差（已写注释备案）

1. **检索契约不改**：`hybridSearch` 签名完全照 10-骨架/04 §4。规格 §4.2 检索测试台的 `datasetId?` 属契约外扩展，controller 里按 doc→dataset 映射**后置过滤**，不动契约。
2. **controller 租户取值降级**：D 未完成时上下文桩不可用，测试台靠显式 `enterpriseId` 字段跑通；D 的 Guard 落地后 `resolveEnterpriseId` 自动优先取 `TenantCtx`（已注释，见 kb.controller.ts）。
3. **UPLOADED→QUEUED 竞态处理**：上传端点 create(UPLOADED)→入队→**条件** `updateMany where status=UPLOADED` 转 QUEUED，worker 若抢先转 PARSING 不覆盖（消除状态写竞态）。
4. **FAILED 非终态**：向量化失败标 FAILED 后抛错走 BullMQ 重试（attempts=3），重试跳过逻辑只认 INDEXED/OCR_NEEDED 两个终态。
5. **测试落点**：`apps/api/tests/rag/`（沿用 A 任务先例，vitest include 只扫 `tests/**`）。未改 `vitest.config.ts` 与共享件。

## 3. 关键实现决策（面试可讲）

- **中文应用层分词已实测验证**：`to_tsvector('simple', '七天 无 理由')` → 独立 lexeme；连续中文 `'七天无理由退货'` 被 PG 默认 parser 当**一个** token（印证规格 §5 深挖区）。
- **ef_search 用事务内 `SET LOCAL`**：会话级参数连接池下会污染别的连接，事务内 `SET LOCAL` 结束自动回滚（已实测 HNSW Index Scan 命中）。
- **RRF 在应用层纯函数**：两路分数量纲不可比（余弦距离 vs ts_rank），只用名次；`rrfFuse` 纯函数单测手算 k=60 一致。
- **幂等 upsert**：`INSERT ... ON CONFLICT ("docId", seq) DO UPDATE`，同 doc 重跑不产生重复 chunk（已实测双跑 chunk 数不变）。
- **租户过滤 JOIN doc**：chunk 无 enterpriseId 列，检索 `JOIN knowledge_docs` 过滤（已实测企业 B 查 A 数据返回 0）。

## 4. 真实数字

- 单测：**33/33**，7 个文件（tokenizer 7 / chunker 7 / rrf 3 / retrieval 5 / docx-parser 4 / quality 4 / chunk.repository 3）。
- 端到端（真实 PGlite 全流程，embedding 用确定性假向量，避免验收前烧 API）：上传 PDF → 解析 861 字 → 分块 [600, 361]（重叠 100）→ 分词 → 事务入库 → 向量/词法双路命中 → 租户隔离 0/0 → `EXPLAIN` 向量走 `knowledge_chunks_embedding_hnsw` Index Scan。
- `tsc --noEmit`：rag 目录 **0 错误**。

## 5. 阻塞与下一步

- **完整 `pnpm typecheck`/`pnpm dev` 当前会失败**：非本任务问题——并行会话 C（`runtime/events.service.ts`）、D（`tenant/**`）正在写入，存在瞬态编译错误。本任务范围（rag）typecheck 与单测全绿。建议在集成任务 J（串行）时统一复跑。
- 本任务**未** `pnpm add`、**未** commit/push、**未**碰共享文件（shared/index.ts 的 `M` 状态为 D 并行写入）。

### 验收命令（用户执行）

```bash
cd D:\project\agent-A
pnpm --filter @agent-rag/api dev          # 监听 3002（需 C/D 的 WIP 先 typecheck 通过）

# ① 造一个企业（测试台显式 enterpriseId 依赖企业行存在）
node --input-type=module -e "
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './apps/api/src/generated/prisma/client.ts'
"   # 或直接 psql 插入：见下方 SQL

# 更简单：psql 造企业
#   INSERT INTO enterprises (name, slug) VALUES ('演示企业','demo-rag') ON CONFLICT (slug) DO NOTHING;

# ② 建数据集（enterpriseId 用上面企业的 id，假定 1）
curl -s -X POST http://127.0.0.1:3002/kb/datasets \
  -H "Content-Type: application/json" \
  -d '{"name":"售后规则","description":"演示","enterpriseId":1}'

# ③ 上传真实 PDF（用已生成的 data/ragtest/demo.pdf 或任意中文电商规则 PDF）
curl -s -X POST http://127.0.0.1:3002/kb/datasets/1/docs \
  -F "file=@D:/project/agent-A/data/ragtest/demo.pdf" \
  -F "enterpriseId=1"
# → 返回 {"docId":1,"status":"QUEUED"}

# ④ 轮询状态流转 UPLOADED→QUEUED→PARSING→INDEXED（前端可见进度）
curl -s http://127.0.0.1:3002/kb/docs/1

# ⑤ 语义问法 + 术语问法各命中
curl -s -X POST http://127.0.0.1:3002/kb/search -H "Content-Type: application/json" \
  -d '{"query":"买错了能退吗","enterpriseId":1}'
curl -s -X POST http://127.0.0.1:3002/kb/search -H "Content-Type: application/json" \
  -d '{"query":"虚假发货扣多少分","enterpriseId":1}'
# 返回 hit 数组含 vectorRank/lexicalRank/rrfScore（可视化双路）

# ⑥ 全绿复核（只跑 rag 范围）
pnpm --filter @agent-rag/api exec vitest run tests/rag
```

**EXPLAIN 截图命令**（本任务已验证 HNSW；GIN 需数据量足够或强制关 seqscan）：

```bash
# 向量路走 HNSW（单行即可见 Index Scan）
psql "$DATABASE_URL" -c "EXPLAIN (COSTS OFF) SELECT id FROM knowledge_chunks ORDER BY embedding <=> '[0.1,0.2,...]'::vector LIMIT 5"

# 词法路走 GIN：数据量少时 planner 选 Seq Scan 属正常 关 seqscan 强制走索引验证
psql "$DATABASE_URL" -c "SET enable_seqscan = off; EXPLAIN (COSTS OFF) SELECT id FROM knowledge_chunks WHERE tsv @@ to_tsquery('simple','七天 | 退货')"
```

## 6. 契约变更提案

无。`RetrievalService.hybridSearch` 与 `RetrievalHit` 签名完全不变；`datasetId` 检索过滤为 controller 后置实现，未进入契约。若后续希望 `datasetId` 下沉到检索契约（评测按数据集跑），建议在 J 任务统一改契约文件。
