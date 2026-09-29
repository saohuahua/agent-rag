# 任务 C · Agent Runtime 报告（2026-09-29）

> 全项目最核心模块。交付物：会话锁+epoch 双层并发控制、turn 主流程（BullMQ 串行 + 同步降级）、工具箱（技能→AI SDK tool + 内置 conversation.handover）、上下文组装、事件 SSE 断线续传、会话 CRUD/admin 接管。工作目录独占 `apps/api/src/runtime/**`（+ `apps/api/tests/runtime/**` 测试）。

## 1. 交付物清单（对照验收逐条）

| 验收项 | 结果 | 证据 |
|---|---|---|
| session-lock.service：Lua 三段逐字 + watchdog + epoch 文件头时序图 | ✅ | `session-lock.service.ts`：RENEW/RELEASE Lua 逐字（§4.2 canonical）+ SET NX 获取 + `bumpEpoch`/`guardEpoch`/`handover` raw SQL + 文件头 ASCII 时序图 |
| turn.processor：BullMQ job group 串行 + 主流程八步 + 同步降级 + pub/sub 流桥 | ✅ | `turn.processor.ts`：`@Processor('agent-turn', { concurrency: 4 })` + `process`（worker）+ `processSync`（同步降级）；锁失败抛错走 BullMQ 重排等效排队（见偏差 1）；`EventsService` 提供 delta pub/sub 桥 |
| toolbox：技能→AI SDK tool 包装 + 内置 conversation.handover | ✅ | `toolbox.ts`：`tool({description,inputSchema,execute})` 收敛三类技能 + 内置 handover；SKILL_START/SKILL_END/SKILL_ERROR 事件 |
| context-builder：消息史 + 模板 + KB INJECT | ✅ | `context-builder.ts`：system 三段（模板 + INJECT top-3 + 工具清单）+ 历史 40 条截断记 TRUNCATE |
| session.controller：CRUD / turn SSE / events SSE 断线续传 / admin takeover | ✅ | `session.controller.ts` 双控制器：`/sessions` 与 `/admin/sessions`；`?afterId=` 断线续传；`?mode=sync` 降级 |
| events.service：ExecutionEvent 落库 + SSE 推 | ✅ | `events.service.ts`：落库 + 内存 EventEmitter 实时推 + `subscribe(afterId)` 先挂监听再回放去重 + delta pub/sub |
| 锁与 epoch 单测全绿（「锁过期被接管后旧 worker 迟到写被拒」真实并发版） | ✅ | `session-lock.redis.spec.ts` 最后一条：真实 Redis 短 TTL + 真实 sleep + 真实并发交错（A 停顿 120ms 超 60ms TTL → B 接管 epoch++ → A 迟到写抛 `StaleEpochError`） |
| 同步降级模式下单员工对话端到端可跑（mock 依赖） | ✅ | `turn.processor.spec.ts`：mock streamText + 全部契约依赖，八步走通，事件时间线 TURN_START→TURN_END，消息 partsJson roundtrip |
| 并发演示脚本（两 turn 一成一排队）可跑 | ✅ | `concurrency-demo.ts`：真实 Redis+DB+BullMQ，自建自清理，日志「第一条 epoch=1 → 第二条 LOCK_WAIT 排队 → epoch=2」 |

## 2. 锁时序图（文字版，与 session-lock.service.ts 文件头一致）

```
  worker A                    Redis                  DB(sessions.epoch)
  ─────────                  ─────                  ──────────────────
  1 SET lock NX PX30s ──────▶ 成功(持有 tokenA)
  2 UPDATE epoch+1 ───────────────────────────────▶ epoch 1 → 2 返回 2
  3 读上下文 生成中(GC 停顿 40s) ………………………………
       │ (锁 TTL 30s 已过期 Redis 自动删锁)
  worker B
  4 SET lock NX PX30s ──────▶ 成功(持有 tokenB 旧锁已过期)
  5 UPDATE epoch+1 ───────────────────────────────▶ epoch 2 → 3 返回 3
  6 B 写消息(带 epoch=3 校验) ────────────────────▶ SELECT FOR UPDATE=3 ✓ 写入
  7 A 苏醒 写消息(带 epoch=2) ────────────────────▶ SELECT FOR UPDATE=3 ✗ ≠2 拒绝
```

要点：Redis 锁只解决「互斥」，不解决「过期后旧持有者继续写」（Kleppmann 批评）；DB epoch(fencing token) 兜底——写前 `SELECT epoch FOR UPDATE` 校验自己的纪元，不等则拒，「正确性不依赖锁的正确性」。watchdog 每 TTL/3 用 Lua「GET==token 才 PEXPIRE」续命。

## 3. 与文档计划的偏差（已注释备案）

1. **job group 降级为「锁失败 + BullMQ 重排」**：BullMQ 免费版 v6.3.9 无 job group（Pro 特性），规格 §3 已预告「不符则降级自写」。实现取 §4.3 step 1 的等效排队：同一会话并发 turn 第二个 `tryAcquire` 失败 → 发 `LOCK_WAIT` → 抛 `LockBusyError` → BullMQ 按 `attempts/backoff` 重排。concurrency=4 保证跨会话并行、同会话串行（由锁串行化）。
2. **新增 ChatModelResolver 契约补丁**：`GatewayService` 契约只暴露 `chat/chatStream`（签名无 tools 参数），而 Runtime 工具循环必须自调 `streamText` 并传 tools，需要 `LanguageModel` 实例。见 §6 契约变更提案。当前 `runtime.module.ts` 提供 `NOT_IMPLEMENTED` 桩（集成由 J）。
3. **handover 后本 turn 继续用原 system prompt**：§4.4「本 turn 继续由新 holder 的模板生成后续内容」未实现 mid-turn 换模板（复杂度过高收益低），只做 epoch++ + 切换 currentParticipant + TAKEOVER，下一 turn 自然用新模板。已注释。
4. **授权降级**：`SessionService.create` 只校验员工属于当前企业，完整「企业→部门→成员」Grant 三层解析待 D 任务、集成由 J。已注释。
5. **测试落点**：`apps/api/tests/runtime/**`（vitest include 只扫 tests/**），与 A/B 一致。

## 4. 踩坑实录（面试可讲）

| # | 坑 | 解法 |
|---|---|---|
| 1 | `SessionLockService` 第三参 `options` 被 Nest 当 DI 依赖（index 2 无 provider → UnknownDependenciesException） | 加 `@Optional()` 装饰器，单测直接 `new` 注入短 TTL |
| 2 | RagModule/SkillsModule 非 `@Global`，RuntimeModule 注入 `RetrievalService`/`SkillExecutorRegistry` 失败 | RuntimeModule 显式 `imports: [RagModule, SkillsModule]`（契约只标了 Gateway/Tenant 全局） |
| 3 | 事件订阅的 `async function*` 内用 `this.replay` → TS2683「this 隐式 any」 | generator 不绑定 this，先在闭包外 `this.replay.bind(this)` |
| 4 | 真实 Redis 单测用 fake Prisma 匹配 raw SQL，换行导致 `UPDATE ... SET epoch = epoch + 1` 匹配不上 | 改匹配子串 `SET epoch = epoch + 1`（bumpEpoch 与 handover 两条 UPDATE 都命中） |
| 5 | `tool()` 的 `execute` 入参类型是 `unknown`（SkillDef.inputSchema 是泛型 ZodType） | 交给 registry 再校验，toolbox 只转发；测试用 `as unknown as { execute }` 断言 |

## 5. 真实数字

- 测试：**32/32 全绿**（6 个文件，其中 `session-lock.redis.spec.ts` 5 条真 Redis 用例 642ms，watchdog 续期用例 415ms）
- 启动：`nest build` + 完整 App 启动成功，`healthz` 返回 `{"db":"ok","redis":"ok"}`，6 条 runtime 路由全部映射
- 并发演示（真实 Redis+PGlite+BullMQ）：

```
[demo] 两个 turn 已同时入队 观察串行与排队
[demo] turn「第一条消息」拿到 epoch=1 开始处理
[demo] turn「第二条消息」锁被占 LOCK_WAIT 排队（attempt=0）
[demo] turn「第二条消息」锁被占 LOCK_WAIT 排队（attempt=1）
[demo] turn「第二条消息」锁被占 LOCK_WAIT 排队（attempt=2）
[demo] turn「第一条消息」完成 epoch=1
[demo] turn「第二条消息」拿到 epoch=2 开始处理
[demo] turn「第二条消息」完成 epoch=2
[demo] 消息 epoch 序列: 「第一条消息」=epoch1 → 「第二条消息」=epoch2
```

## 6. 契约变更提案（§9 流程，用户裁决）

**问题**：Runtime 的 agent 工具循环按规格 §2.3/§4.3 需自调 `streamText({ model, messages, tools })`，但 `GatewayService`（10-骨架/04 §2）只暴露 `chat/chatStream/embedMany/embeddingHealthy`，没有「取模型实例」的方法，也没有带 tools 的流式接口。

**建议签名**（加到 GatewayService）：
```typescript
/** 按路由别名解析一个可流式 chat 模型（Runtime 工具循环用）降级链/预算/健康由内部负责 */
resolveChatModel(alias: string): Promise<LanguageModel>
```

**影响面**：仅 GatewayService 新增一个方法（无破坏性变更）；Runtime 侧 `agent-model.ts` 的 `CHAT_MODEL_RESOLVER` 桩替换为一行委托 `gateway.resolveChatModel`。备选方案（`chatStream` 加可选 `tools` 参数）改动面更大且与 OpenAI 兼容层语义纠缠，不建议。

## 7. 验收命令（已全部验证通过）

```bash
cd D:\project\agent-A
pnpm db:up                        # 起 PGlite + Redis（锁/epoch 真并发单测与演示依赖）

# ① 类型检查（只跑 src 无我的错误；tests 内 rag 错误属并行任务 B 未完成）
pnpm --filter @agent-rag/api exec tsc --noEmit

# ② 锁与 epoch 单测全绿（32 条 含真实并发版）
pnpm --filter @agent-rag/api exec vitest run tests/runtime

# ③ 并发演示脚本：两 turn 一成一排队 日志含 epoch 序列
pnpm --filter @agent-rag/api exec tsx src/runtime/concurrency-demo.ts

# ④ 完整构建 + 启动自检（healthz 200 六条 runtime 路由映射）
pnpm --filter @agent-rag/api build
API_PORT=3999 node apps/api/dist/main.js   # 另开终端 curl :3999/healthz
```

## 8. 边界确认

- 仅改动 `apps/api/src/runtime/**` 与 `apps/api/tests/runtime/**`；未触碰 gateway/rag/skills/tenant/共享文件（git status 中 rag/tenant/web/shared 的改动属并行任务 B/D/E）。
- 未 `pnpm add`；未 commit/push。
