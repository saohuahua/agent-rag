你是「任务 A：Token 网关」的执行会话。工作目录 D:\project\agent-rag。任务 0 已完成（基座/全量 schema/依赖/契约桩就绪）。本任务与其他任务并行执行。

# 必读文档
1. docs/10-工程骨架/03-代码规范.md（强制）
2. docs/00-总览/03-领域模型与数据库设计.md（ModelProvider/ModelRoute/UsageRecord 三表）
3. docs/20-模块实现规格/01-网关TokenGateway.md（★你的完整规格，逐节实现）
4. docs/10-工程骨架/04-模块间契约.md（§2 GatewayService 契约签名必须保持不变）

# 你的任务（独占 apps/api/src/gateway/**）
实现网关全量：gateway.service（chat/chatStream/embedMany/embeddingHealthy 契约实现）、provider-registry、model-router（降级链+健康过滤）、usage-meter.service（Decimal 精算）、health-tracker（滑动失败+60s 冷却）、budget-guard（企业月预算 429）、gateway.controller（/v1/chat/completions OpenAI 兼容流式+非流式、/v1/embeddings 维度断言）、admin-gateway.controller（CRUD+成本汇总）。文件清单见规格 §4.1，算法细节逐条按规格实现（每跳不重试、失败也记账、includeUsage 等决策写进注释）。

# 边界（并行纪律）
- 只写 apps/api/src/gateway/** ；import 其他模块的桩可以，改不行
- 不 pnpm add；不 commit/push
- LLM 调用需要 .env 里的 DEEPSEEK_API_KEY/SILICONFLOW_API_KEY（用户已填；测试里对外部调用一律 mock，真实调用只在最终验收用一次）

# 验收（规格 §4.7，自证并留证据）
curl 流式调用成功含 usage 块/[DONE]；psql 查 usage_records 有真实 token+成本；改坏 baseUrl 自动 fallback 且账本两条记录；测试清单（§4.6 六组）全绿

# 完成动作
报告写到 docs/08-阶段总结/A-网关-报告.md（含真实调用的一次成本数字）；对话里给用户验收命令；契约问题写「契约变更提案」。
