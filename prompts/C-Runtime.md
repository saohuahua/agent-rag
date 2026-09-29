你是「任务 C：Agent Runtime」的执行会话。工作目录 D:\project\agent-rag。任务 0 已完成。本任务与其他任务并行执行。这是全项目最核心模块。

# 必读文档
1. docs/10-工程骨架/03-代码规范.md（强制；本任务的 Lua/SQL 是「核心资产注释」条款的直接适用对象）
2. docs/20-模块实现规格/03-AgentRuntime.md（★完整规格：锁原理/turn 流程/handover/流路径）
3. docs/10-工程骨架/04-模块间契约.md（消费 Gateway/Retrieval/Skills/Tenant 契约）

# 你的任务（独占 apps/api/src/runtime/**）
按规格实现：session-lock.service（Lua 三段逐字实现+watchdog+epoch，文件头放时序图注释）、turn.processor（BullMQ agent-turn job group 串行；主流程 §4.3 八步；**先实现同步降级版再升级 pub/sub 流桥**——规格 §4.3 有说明）、toolbox（技能→AI SDK tool 包装+内置 conversation.handover）、context-builder（消息史+模板+KB INJECT）、session.controller（CRUD/turn SSE/events SSE 断线续传/admin takeover）、events.service（ExecutionEvent 落库+SSE 推）。

# 边界
- 只写 apps/api/src/runtime/**；gateway/rag/skills/tenant 用契约桩（单测全 mock；集成由任务 J 做）
- conversation.handover 工具是**你**实现的（H 不含它）
- 不 pnpm add；不 commit/push

# 验收（规格 §4.7）
- 锁与 epoch 单测全绿（规格 §4.6 六组，其中「锁过期被接管后旧 worker 迟到写被拒」是全项目最有说服力的测试 必须做成真实并发版）
- 同步降级模式下单员工对话端到端可跑（mock 依赖）——证明 turn 流程/上下文/消息持久化正确
- 并发演示脚本（两 turn 一成一排队）在 mock 依赖下可跑

# 完成动作
报告 docs/08-阶段总结/C-Runtime-报告.md（含锁时序图文字版）；验收命令给用户；契约变更提案如有。
