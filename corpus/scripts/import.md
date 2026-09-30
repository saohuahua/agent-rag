# corpus 导入说明（import.md）

> 语料如何进入知识库（RAG 检索库）。本目录是 F 任务的交付物，说明语料的批量导入路径与幂等语义。

## 1. 两条导入路径

| 路径 | 入口 | 输入 | 适用 |
|---|---|---|---|
| **语料批量入库** | `pnpm demo:scenario`（或 `pnpm eval:rag`） | `corpus/laws|rules|helpdocs/*.md` | 把采集的规则/法规/帮助文档 md 整批解析入库 |
| **上传 API** | `POST /kb/datasets/:id/docs`（multipart） | PDF / DOCX（≤20MB） | 演示「上传→异步解析→入库」的运行时能力 |

## 2. 语料批量入库（corpus → 知识库）

实现：`apps/api/src/demo/corpus-ingest.ts`（`ingestCorpus`），由 demo 脚本调用。

流程：

1. `pnpm db:seed` 先建好演示企业「好物严选」与数据集「规则知识库」；
2. `pnpm demo:scenario` 启动接管剧本，其中第 0 步即调用 `ingestCorpus` 把 `corpus/` 三个子目录（`laws/ rules/ helpdocs/`）的 md 全部解析入库；
3. 每篇 md：剥 frontmatter（`source`/`tags` 等元数据不进 chunk，避免污染词法检索）→ 取 `doc_id` → 作为单个文本块走 `chunker` 分块（600 字/块、重叠 100）→ `tokenizer` 分词 → `gateway.embedMany` 向量化 → 事务入库 → 状态置 `INDEXED`。

幂等语义（重跑不重复不烧钱）：

- doc 按 `(datasetId, checksum)` 去重，`checksum` = 正文 sha256；
- 已 `INDEXED` 的 doc 直接跳过（嵌入缓存），评测复跑只对新增语料调用 embedding。

## 3. 上传 API（PDF/DOCX 运行时路径）

演示「客服把平台规则 PDF 上传进企业知识库」的异步管线：

```bash
# 建数据集
curl -s -X POST http://127.0.0.1:3002/kb/datasets \
  -H "Content-Type: application/json" \
  -d '{"name":"售后规则","description":"演示","enterpriseId":1}'

# 上传真实 PDF（data/ragtest/demo.pdf 或任意中文电商规则 PDF）
curl -s -X POST http://127.0.0.1:3002/kb/datasets/1/docs \
  -F "file=@D:/project/agent-A/data/ragtest/demo.pdf" \
  -F "enterpriseId=1"

# 轮询状态流转 UPLOADED→QUEUED→PARSING→INDEXED
curl -s http://127.0.0.1:3002/kb/docs/1
```

## 4. 新增语料后的动作

1. 新 md 放对应子目录（`rules/` `laws/` `helpdocs/`），frontmatter 补齐 `doc_id / source / collected_at`；
2. 若希望新语料进入检索库：重跑 `pnpm demo:scenario` 或 `pnpm eval:rag`（幂等，只处理新增 doc）；
3. 若希望 QA 对（`qa/`）也参与检索：需在 `corpus-ingest.ts` 的 `CORPUS_SUBDIRS` 加入 `qa`（当前有意不加入，见 `qa/README.md`）；
4. 更新 `corpus/README.md` 的数量统计与来源表。
