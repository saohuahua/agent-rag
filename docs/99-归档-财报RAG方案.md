# 【归档】A 股财报 Agentic RAG + Deep Research 项目方案（已作废）

> **状态**：已作废。2026-09-28 完成方案设计，2026-09-29 经 grilling 确认后放弃，转向当前项目（硅基员工平台，TS 全栈）。
> **保留原因**：① 方案本身的调研成果与技术设计有参考价值；② 它的评测方法论（消融矩阵/分题型报告）已完整迁移到当前项目 M2 模块；③ 面试可讲「做了全面调研后发现风险、果断转向」的决策过程。
> **当时定位**：面向 A 股上市公司年报（表格密集复杂 PDF）的 Agentic RAG 系统，Python 技术栈，作为 2026 秋招简历项目。

---

## 一、为什么当时选这个方向（调研结论）

2026-09-28 调研（4 个调研 agent，覆盖技术格局/求职视角/场景全景/架构验证）：

1. **同质化警告**：纯「LangChain + 向量库 + 聊天界面」的知识库问答项目是简历负资产——GitHub #rag 话题 5 万+ 仓库，面试官明确说这类简历直接 pass。
2. **面试深挖固定套路**：真实场景（谁在用、答错会怎样）→ 检索链路每个选型依据（chunk 策略/混合检索/TopK）→ **评测体系（Recall@K/MRR/faithfulness、测试集构建、改动前后数字）** → 幻觉兜底与引用溯源 → 线上视角（badcase 闭环/成本延迟）。评测是 JD 不写但面试必问的。
3. **2026 技术共识反转**：论文实测「单 agent + 固定混合检索 + 2 轮迭代」能拿到复杂多 agent 系统 95% 的收益——亮点不在堆 agent 复杂度，而在解析质量、量化评测、成本工程、失败模式处理。
4. **高价值切入点**：表格密集型复杂文档 RAG（TableRAG NeurIPS 2024 论文背书）+ Deep Research 融合，个人项目同质化极低。

## 二、方案总览

**一句话**：深度文档解析 + 混合检索 + CRAG 反思检索 + Deep Research 报告生成，全链路量化评测与成本工程。

**技术栈**（当时已逐项验证）：Python 3.11+（uv 管理）｜ FastAPI ｜ LangGraph 1.x 编排 ｜ Qdrant v1.19（dense+sparse+prefetch/RRF）｜ docling CPU 主解析 + MinerU API 兜底 ｜ Arize Phoenix 可观测（弃 Langfuse：自托管 6 组件过重）｜ MCP Python SDK v2 ｜ DeepSeek + SiliconFlow（无 GPU 全 API 化，预算 <¥150）。

**数据流**：

```
[cninfo 批量下载脚本] → raw PDFs
  → 解析层：docling(本地CPU) + MinerU vlm API(对照/兜底) + PyMuPDF/pdfplumber(基线)
  → Canonical Doc JSON（页/块/表格结构+caption+页码溯源）
  → 分块：layout-aware(标题层级+表格整存+上下文头) vs naive-512token(消融对照)
  → 索引：Qdrant named vectors — dense(BGE-M3) + sparse(服务端BM25 或 fastembed+jieba)
  → 检索：查询改写/分解 → hybrid(prefetch+RRF) → BGE-reranker 重排 → top-5
  → LangGraph：naive 基线线 ｜ CRAG 反思线 ｜ Deep Research 线(planner→并行researcher→scratchpad→synthesizer)
  → 生成：引用 chunk id 强制溯源 + 拒答策略 + 模型分工(便宜模型干粗活)
  → 接口：FastAPI SSE 双通道 + MCP server
  → Vue3 前端 + 评测体系(Recall@K/MRR/faithfulness/成本延迟) + Phoenix trace
```

**模型分工**：DeepSeek flash（¥1/M 输入）干粗活（改写/评分/judge），强模型只做最终合成；embedding/rerank 走 SiliconFlow 近零成本；自写薄适配层（provider registry 防模型换代风险）。

## 三、评测体系设计（已迁移到当前项目 M2）

- **测试集**：150–200 题四题型分级（单跳事实 50 / 多跳对比 40 / 表格计算 40 / 拒答陷阱 20），gold chunk 双校验（LLM 预标注+人工抽检 10%），数值题带 gold answer。
- **指标**：Recall@5/@10、MRR@10；faithfulness/answer-relevance（自写 LLM-judge + RAGAS 交叉对照）；表格计算 ±1% 容差数值等价；拒答双向（正确拒答率+误拒率）；端到端成本（元/查询）与延迟 P50/P95。
- **消融矩阵 L0→L5**：naive → +layout-aware chunking → +sparse hybrid → +rerank → +CRAG+查询分解 → Deep Research。分题型拆解，展示 agentic 层在哪类题回本、哪类是纯开销。
- 结果入 git，README 只放这张表。**分题型报告收益与代价，若提升 <2pp 则诚实分析原因**——「知道自己方法边界」比假数字值钱。

## 四、分阶段计划（当时版）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | uv 项目、docker-compose(Qdrant+Phoenix)、配置中心、LLM 薄适配层+成本计量、端到端冒烟 | 冒烟一次精确费用可报出 |
| P1 | cninfo 下载脚本（5–8 家跨行业公司×2 年报）、docling 批量管道、Canonical JSON | 抽 20 张表格人工核对 ≥90% |
| P2 | 双版本 chunking、双路索引、150–200 题测试集、检索评测 harness、RRF 实验、rerank | 消融矩阵 v1；单跳 Recall@10 ≥0.80 |
| P3 | 答案生成+强制引用+拒答、LLM-judge、SSE、Vue3 对话页 | 200 题一键跑通，naive 数字=后续分母 |
| P4 | LangGraph CRAG 反思+查询分解+checkpointer | 消融矩阵 v2，多跳/计算题分题型对比 |
| P5 | Deep Research（planner→并行 researcher→synthesizer）、预算熔断、报告页 | 跨公司对比报告引用 100% 可核验 |
| P6 | MCP server、前端打磨、README、demo 录屏、面试资产 | 文档自测通过 |

## 五、成本估算（当时）

全程约 ¥55–125（中位 ~¥80）：cninfo 下载免费；docling 本地 CPU 免费；MinerU API 1000 页/天免费额度；embedding ~¥0–10；rerank ~¥0–20；评测+开发 LLM ¥40–70；强模型报告合成 ¥15–25；预算护栏 ¥150 全局熔断。

## 六、为什么作废（决策记录，2026-09-29）

1. **触发**：用户看到一段更匹配自身背景的「企业 AI 中台」简历项目（TS 全栈：NestJS/Next.js/Vercel AI SDK/pgvector/BullMQ），要求评估复刻可行性。
2. **关键权衡**：
   - 用户是 Vue 前端出身——TS 全栈项目的「写/讲/扩展」都远比 Python 顺，前端优势能直接转化为项目质量；
   - 目标岗位「AI 应用/Agent 开发工程师」在 2026 年的 JD 生态（Dify/Coze 类平台岗）本身就是 TS 全栈为主；
   - 财报场景需要啃 docling/MinerU 文档解析深水区（无 GPU 约束下风险集中），而中台项目的难点（分布式锁/多租户/网关）是纯工程问题，AI 辅助可控性更高；
   - 调研结论（烂大街警告、评测必问、深水区才有区分度）对新项目同样成立，沉没成本低。
3. **成果迁移**：评测方法论（消融矩阵/分题型/诚实报告）→ 当前项目 M2 的 `pnpm eval:rag`；文档体系设计（五段式+自测题）→ 当前 docs/；「算力统一计量」的成本账本思想 → 当前 UsageRecord。
4. **教训沉淀**：方向决策应先确认「和自己技能栈的匹配度」再确认「技术含量」——技术含量再高，做的人讲不出来就没有简历价值。

---

*本文件为历史归档，方案不再维护。当前项目见 [README](../../README.md) 与 [docs/00-总览](../00-总览/)。*
