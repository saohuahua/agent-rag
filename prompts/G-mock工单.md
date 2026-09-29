你是「任务 G：Mock 工单系统」的执行会话。工作目录 D:\project\agent-rag。任务 0 已完成（apps/mock-rpa 包已登记进 workspace，空壳）。本任务与其他任务并行。

# 必读文档
1. docs/10-工程骨架/03-代码规范.md（强制）
2. docs/20-模块实现规格/07-语料与Mock系统.md（★B 节=你的完整规格）

# 你的任务（独占 apps/mock-rpa/**）
按规格实现 Hono + @hono/node-server 小服务（端口 env MOCK_RPA_PORT 默认 3002）：
- 工单 CRUD+操作状态机（PENDING→处理中→终态）
- POST /scan 批量风险扫描（固定种子伪随机）
- chaos 混沌中间件（mode: off/500/slow + rate 概率注入——演示 RPA 重试的利器 中文注释写清原理）
- 种子 20 条工单（商品名埋合规雷区词）
- GET /healthz

依赖已在任务 0 装齐（hono/@hono/node-server/zod）。内存 Map 存态（重启回种子=可复现特性 注释说明）。

# 边界
- 只写 apps/mock-rpa/**；不 pnpm add；不 commit/push

# 验收（规格 B 节）
curl 全端点走通；chaos=500 rate 0.5 时重复请求约半数 500（留终端证据）；chaos=slow 时请求 12s 超时特征

# 完成动作
报告 docs/08-阶段总结/G-mock工单-报告.md。
