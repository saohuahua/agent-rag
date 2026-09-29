# 20-07 · 模块规格：语料采集（F）与 Mock 工单系统（G）

> 两个外部资源任务，互不依赖、不碰代码目录，可与任何任务并行。

## A. 语料采集（F 任务 · 独占 `corpus/`）

### 目标

为「小规」（规则答疑）、「上架侠」（合规）、「售后侠」（政策）三个员工提供**真实、可再生产**的知识语料，并为 RAG 评测提供 golden 测试集。首批规模 **~100 篇**（集成期扩到 200+）。

### 语料组合（调研结论：淘宝/京东/拼多多规则中心反爬严格，不硬啃）

| 来源 | 内容 | 获取方式 | 数量目标 |
|---|---|---|---|
| 抖音电商学习中心（school.jinritemai.com） | 平台规则/治理规范/售后政策 | 人工浏览+浏览器另存/复制（列表页 JS 渲染 自动爬不稳）；每篇存 `.md`（frontmatter 记来源 URL+采集日期） | 40+ |
| 公开电商法规 | 《电子商务法》《网络交易监督管理办法》《消费者权益保护法》(节选) 等全文 | 政府公开文本 手动复制 | 5+ |
| 平台公开帮助文档 | 淘宝/拼多多商家帮助中心可访问页 | 手动复制 | 20+ |
| 禁限售词表 | 违禁词/极限词/类目敏感词 | 整理自公开规则文档（合规引擎用） | 1 份 words.json（≥300 词） |
| 行业 FAQ | 客服常见问答（ChineseNlpCorpus 的电商/外卖类可参考格式） | 重组为 Q&A 文档 | 若干 |

### corpus/ 目录结构（F 任务产出）

```
corpus/
├─ README.md               # ★采集记录：来源/方式/数量/许可说明（为什么可合规使用）
├─ rules/                  # 平台规则原文 md（frontmatter: source/date/title）
├─ laws/                   # 法规文本
├─ helpdocs/               # 帮助文档
├─ qa/                     # FAQ 问答对
├─ compliance/words.json   # 禁限售词表（上架侠用）
├── golden/rag-eval.jsonl  # 评测题：{question, goldChunkKeywords[], tags[], goldAnswer?}
└── scripts/import.md      # 导入说明（如何批量上传入库→上传 API or MANUAL 文档接口）
```

### golden 测试集要求（给 30-评测用）

- ≥40 题，四类分布：单跳事实 15 / 多跳对比 8 / 表格数值 4（平台规则多为条款可改「计算题」如运费/时效） / **拒答陷阱 8**（问语料中不存在的内容，正确行为=拒答）；
- 每题标注 `goldKeywords`（命中即算召回的 2-4 个特征词组）——chunk 级 gold 标注难度大，用关键词命中近似（方法论在 30-评测里如实写）；
- 出题方式：人读语料手写 60% + LLM 从语料反向生成草题人工过滤 40%。

### 验收

- rules/ ≥40 篇且 frontmatter 完整；words.json ≥300 词含严重度标注；
- golden 集 ≥40 题四类分布达标；README 采集记录完整（每个来源有 URL 与日期）。

## B. Mock 工单系统（G 任务 · 独占 `apps/mock-rpa/`）

### 目标

RPA 技能的「第三方系统」替身：一个独立小服务（Hono + 内存态），模拟工单 CRUD 与批量扫描 API——让 `operate_ticket`/`batch_scan` 有真实的 HTTP 操作对象（超时/重试/失败注入都可演示）。

### API 契约

| 端点 | 说明 |
|---|---|
| `GET /tickets` / `POST /tickets` | 工单列表/创建（种子 20 条退货/售后单） |
| `POST /tickets/:id/operate` | `{action: 'refund'\|'reject'\|'escalate', note?}` 状态机流转 PENDING→处理中→终态 |
| `POST /scan` | `{productIds: string[]}` 返回每商品风险分级（按词表随机+固定种子） |
| `GET /chaos` / `POST /chaos` | 混沌开关：`{mode: 'off'\|'500'\|'slow', rate: 0.5}` ——**演示 RPA 重试的利器**（请求 500/慢响应注入） |
| `GET /healthz` | 健康检查 |

### 实现要点

- Hono + `@hono/node-server`，端口 env `MOCK_RPA_PORT=3002`；
- 内存 Map 存工单（重启回种子态——是特性不是缺陷：可复现 demo）；
- 种子：20 条工单（商品名含合规雷区词若干，供扫描联动）；
- chaos 实现写中文注释（中间件概率注入 500/延迟 12s）。

### 验收

- `curl` 全端点走通；chaos=500(rate 0.5) 时 H 的 RPA 执行器出现「重试 2 次后成功/失败」日志（联动证据）。

## 自测题

1. 为什么语料走「半人工采集」而不是写爬虫？（反爬/合规/时间成本三角）
2. mock 系统的 chaos 开口为什么是验收 RPA 重试的必要件？
