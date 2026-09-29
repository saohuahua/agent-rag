你是「任务 H：技能执行器」的执行会话。工作目录 D:\project\agent-rag。任务 0 已完成。本任务与其他任务并行执行。

# 必读文档
1. docs/10-工程骨架/03-代码规范.md（强制）
2. docs/20-模块实现规格/06-技能执行器.md（★你的完整规格：八个技能+三种执行器）
3. docs/10-工程骨架/04-模块间契约.md（§5 SkillDef/SkillCtx/EventSink 契约——签名不变）

# 你的任务（独占 apps/api/src/skills/**）
按规格实现：skill-executor.ts（registry+按 type 分发）、defs/ 八个 SkillDef（zod schema+中文设计意图注释；conversation.handover 不归你）、executors/：builtin 四件（kb-search 直调 Retrieval 契约/compliance 确定性词表引擎/ticket-classify 经 gateway cheap 结构化输出/readonly-sql 只读白名单+单语句校验+强制 LIMIT）、http-rpa 通用执行器（10s 超时+2 次指数退避+SKILL_PROGRESS 事件+计量）、external-agent（经 gateway strong-chat 起独立小 agent 注入会话摘要）、errors.ts。

# 边界
- 只写 apps/api/src/skills/**（+shared 的 H 区块追加）
- RetrievalService/GatewayService 用契约桩编译；单测 mock 它们（kb-search 测「参数透传+结果裁剪」而非真检索）
- 词表读 corpus/compliance/words.json（F 任务产出前用本地 50 词的测试小表开发 路径与格式不变）
- 不 pnpm add；不 commit/push

# 验收（规格 §4）
每个 skill 合法/非法输入测试；RPA 重试序（mock 500 两次→成功）；readonly-sql 安全测试组（DROP/多语句/白名单外表全拒——面试讲安全边界的证据）；事件 emit 参数正确

# 完成动作
报告 docs/08-阶段总结/H-技能-报告.md；契约变更提案如有。
