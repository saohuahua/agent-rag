# 40-04 · P3 Agent Runtime 攻坚（C 任务串行）

> 目标一句话：全项目最重的模块独占一个阶段——真模型流式对话全链路 + 并发正确性（锁 / epoch / 按序接管）。攻坚期不并行其他任务：C 是集成密度最高的一段，出问题必须能专注定位。

## 1. 前置

- P0-P2 全勾；A/B/D/H 真实现可用（不再吃桩）。

## 2. 开工先写

- 20-规格/03-M3-AgentRuntime.md（本阶段唯一规格、篇幅最长：把 00-总览/02 §2 的数据流走读逐句落成接口与文件清单）；
- prompts/C-Runtime.md。

## 3. 任务分解（三个子批，每批一个可验证里程碑）

1. **批次 1 链路通**：turn 入队（BullMQ job group = sessionId）→ worker 取 job → streamText（经 A）→ 消息落库（带 employeeId+epoch）→ SSE 推流 → 前端打字机渲染。验收：单员工纯文本对话真模型跑通；
2. **批次 2 并发正确**：Redis 锁 Lua 三段（acquire / watchdog 续期 / 释放，含强制注释）+ DB epoch fencing（00-总览/03 §3 的两条 SQL 语义）+ 迟到写拦截 + 并发演示脚本。验收：并发脚本一成一排队，fencing 拦截测试绿；
3. **批次 3 工具与接管**：模板技能包装 tools（经 H，inputSchema 转 AI SDK tool）+ kb_search 双模式（KbMode INJECT 进 system / TOOL 按需检索）+ handover 接管（slot 顺序 / currentParticipant 更新 / epoch 递增）。验收：客服带知识库答题可溯源（chunkId/page），接管事件序列正确。

## 4. 验收门槛

- [ ] 单员工流式对话端到端：web 输入 → 打字机 → 消息落库带 employeeId+epoch；
- [ ] 并发脚本：同会话 5 并发 turn，一成一排队，无交错写；
- [ ] fencing：构造锁过期被接管场景，旧 worker 写入被拦（有测试证明）；
- [ ] 断网关 / 断 Redis 的错误路径有明确错误码与 ExecutionEvent（DEGRADE / SKILL_ERROR）；
- [ ] ExecutionEvent 时间线前端实时滚动（E 的组件接真流）；
- [ ] pnpm typecheck + test 全绿。

## 5. 风险提示

- BullMQ job groups API 与版本不符 → 直接走风险手册 §1.1 降级（Redis LIST+BRPOPLPUSH），不恋战；
- 锁与 epoch 的任何语义拿不准，以 00-总览/03 §3 行为语义表为准，改语义先改文档。

## 6. 收尾动作

- 回写 08-阶段总结/03-P3.md；tag `p3`；
- 讲解复盘**做两次**（06-路线图标注「全项目最重」）：锁与 epoch 一次、工具循环与接管一次；
- 成本对账。
