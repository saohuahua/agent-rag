# 20-03 · 模块规格：Agent Runtime（M3 · C 任务）

> 全项目**最有讲头**的模块。五段式：业务问题 → 原理（含锁与 fencing 深挖）→ 选型对比 → 实现规格 → 面试深挖区。

## 1. 业务问题

1. **并发写坏上下文**：售后侠正在处理工单（读上下文→生成→写回），用户此刻又发一条消息触发第二个 turn，两个 worker 并发读写同一段会话上下文→消息错乱、覆盖、丢轮次；
2. **多员工接力**：一个会话里售后处理完转给扫描员再转给周报员，需要「按序接管 + 共享上下文」；
3. **异构能力统一**：查知识库（函数）、操作工单系统（HTTP RPA）、请外部专家（外部 agent）——用户视角都是「员工会干活」。

## 2. 原理

### 2.1 会话锁（Redis）+ epoch（DB）双层——先讲清为什么两层

**锁解决「互斥」**：`SET lock:session:{id} token NX PX 30000`——「不存在才设置+过期」是原子的；token 是每次获取生成的 UUID，释放时「GET==token 才 DEL」（Lua 原子），防止 A 的锁过期后 B 拿到，A 迟到的 DEL 把 B 的锁删掉。

**但锁不绝对安全（Kleppmann 的经典批评）**：A 的进程在持锁期间 GC 停顿/网络分区 40s，锁 TTL 30s 已过期，B 拿锁接管 epoch=7；A 苏醒继续写——它以为自己是持有者。Redis 层拦不住（锁已易主）。

**epoch（fencing token）在 DB 层兜底**：每次成功拿锁 `UPDATE sessions SET epoch=epoch+1 RETURNING epoch`；写消息的事务内 `SELECT epoch FOR UPDATE` 校验等于自己的纪元，不等则放弃。旧持有者的迟到写被数据库拒绝——**正确性不依赖锁的正确性**。

watchdog 续期：持有期间每 TTL/3 用 Lua「GET==token 则 PEXPIRE」续命，防止长任务正常执行中被过期。

### 2.2 按序接管

- 阵容：`session_participants` 的 slot（0,1,2…）决定顺序；
- turn 串行：BullMQ `agent-turn` 队列，**job group = sessionId**（同组严格串行）；
- 接管触发：①LLM 调 `conversation.handover` 工具（自主转接）；②用户 @ 员工；③管理 API。接管 = 锁保护下 epoch++ + `current_participant` 切换 + TAKEOVER 事件。

### 2.3 Agent loop 与技能统一

`streamText({ model, messages, tools, onFinish })`——LLM 每轮可返回 tool_calls，SDK 自动执行 `execute` 并把结果回喂 LLM，循环直到产出最终文本。**三类技能统一**=每个技能都是 `tool({description, inputSchema, execute})`，execute 内部按类型分发（见 20-规格/06）。

## 3. 选型对比

| 决策 | 选 | 没选 | 一句话 |
|---|---|---|---|
| 锁 | SET NX+Lua+watchdog | redlock 库 | redlock 休眠 4 年；Kleppmann 批评其无 fencing 依赖时钟；单 Redis 效率型锁+DB epoch 是教科书方案 |
| 正确性兜底 | DB epoch | 锁内做全同步 | 锁过期的迟到写必须被数据层拒绝 不是靠「更小心」 |
| turn 串行 | BullMQ job groups | 自写 LIST+BRPOPLPUSH | 官方特性零维护；不符则降级自写（50 行 叙事不变） |
| 流式 | pipeUIMessageStreamToResponse | 自拼 SSE | 官方 cookbook 模式 前端 useChat 免解析 |

## 4. 实现规格

### 4.1 文件清单（C 任务独占 `apps/api/src/runtime/`）

```
runtime/
├─ runtime.module.ts          // 注册 agent-turn 队列/worker/controllers
├─ session.controller.ts      // 会话 CRUD / turn 发起 / 事件 SSE
├─ session.service.ts         // 建会话（阵容校验+授权）消息加载
├─ session-lock.service.ts    // ★锁三段 Lua + watchdog + epoch（文件头放时序图注释）
├─ turn.processor.ts          // BullMQ WorkerHost：agent turn 主流程
├─ toolbox.ts                 // 技能→AI SDK tool() 包装（含 handover 内置工具）
├─ context-builder.ts         // 上下文组装（消息史+模板+KB INJECT 注入）
└─ events.service.ts          // ExecutionEvent 落库 + SSE 推送
```

### 4.2 锁的 Lua 三段（canonical 逐字实现）

```lua
-- ① 续期 watchdog 每 TTL/3 调用
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0

-- ② 释放（原子校验防误删：A 过期 B 持有后 A 迟到的 DEL 不能删掉 B 的锁）
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
```

获取=单命令 `SET key token NX PX 30000`（无需 Lua）。TTL=30s，watchdog 间隔 10s，用 `setInterval` 且在释放时 `clearInterval`。

### 4.3 turn 主流程（turn.processor.ts）

```
job { sessionId, userMessage }（group=sessionId）
1 tryAcquire 锁 → 失败：job 抛错 BullMQ 自动重排（等效排队）记 LOCK_WAIT 事件
2 epoch = UPDATE ... SET epoch=epoch+1, current_participant_id=$cur WHERE id RETURNING epoch
3 存 user 消息（带 epoch）
4 context = context-builder：
    system = 模板 systemPrompt +（KbMode 含 INJECT 时检索 top-3 拼入）+ 工具清单说明
    history = 会话消息（全量 上限 40 条 截断记事件）
5 tools = toolbox（技能来自当前模板绑定 + 内置 conversation.handover）
6 streamText(gateway.chatStream 内部调用… 简化：toolbox 的 execute 里 emit SKILL_* 事件)
7 流结束 onFinish：存 assistant 消息（parts 原样+text 冗余 employeeId+epoch）
8 TURN_END 事件 释放锁（finally 必释放——watchdog 停止）
```

**流式输出到前端的路径**：worker 内 streamText 的 delta →（Redis pub/sub `session:{id}:stream`）→ controller 的 SSE 订阅转发 → useChat。**为什么绕一跳**：HTTP 请求在入队后即返回，真正生成在 worker 进程——pub/sub 是两进程间的流桥。降级方案（若 pub/sub 复杂度超预期）：同步执行模式（turn 请求内直接跑完整流程不开 worker，锁仍生效）——先实现降级版再升级，演示脚本不变。

### 4.4 handover 工具规格

```typescript
// conversation.handover —— LLM 可自主转接 这是「多员工接管」的灵魂触发器
inputSchema = z.object({
  targetEmployeeKey: z.string().describe('目标员工的 displayName 或 id'),
  reason: z.string().describe('转接原因 将展示给用户'),
})
execute:
  1 校验 target ∈ 本会话 participants（不在则返回错误摘要 LLM 会告知用户）
  2 校验 slot 顺序（只能向后接管 slot 更大？——不限制 双向可接管 由 LLM 判断）
  3 锁保护下：epoch++ current_participant 切换 TAKEOVER 事件（payload 含 reason）
  4 返回 { ok, newHolder }——本 turn 继续由新 holder 的模板生成后续内容
```

### 4.5 HTTP API

| 端点 | 说明 |
|---|---|
| `POST /sessions` | `{title?, participantEmployeeIds: number[]}` 建会话（授权校验：每个员工对当前成员有 Grant） |
| `GET /sessions` / `GET /sessions/:id` | 列表/详情（消息+参与者+当前持有者+epoch） |
| `POST /sessions/:id/turns` | `{message}` → 202 + SSE 流（见 §4.3 流路径） |
| `GET /sessions/:id/events` | SSE 事件流（实时订阅 + `?afterId=` 断线续传） |
| `POST /admin/sessions/:id/takeover` | 管理接管 `{employeeId}` |

### 4.6 测试清单

- 锁：tryAcquire 互斥；释放后可再获；token 校验（A 释放不影响 B 的锁——用两个 client 模拟）
- watchdog：持有 >TTL 的任务锁不丢（fake timers）
- epoch：模拟「锁过期被接管后旧 worker 迟到写」→ 旧写被拒（本测试是全项目最有说服力的单测，做真实并发版）
- turn 串行：同 session 两 job 顺序执行（集成测试 真实 BullMQ）
- handover：不在阵容的目标被拒；TAKEOVER 事件 payload 正确
- 消息持久化：partsJson 可回放（roundtrip）

### 4.7 验收

- 单员工（小规）流式问答带 kb_search 工具调用全程可见（时间线：TURN_START→SKILL_START→SKILL_END→TURN_END）
- 会话内 售后侠→扫雷 handover 成功，新 holder 能引用旧对话内容（共享上下文证据）
- 并发演示脚本：两 curl 同时发 turn → 一成功一排队（第二次 job 重试后执行），日志含 epoch 变化序列

## 5. 面试深挖区（背熟这一节）

- 「锁过期了怎么办？」→ 三段答：TTL 是必要的（持有者崩溃防死锁）；过期会产生「双持有」窗口；所以 DB epoch fencing——写前校验纪元，迟到写被拒。场景：GC 停顿 40s 的旧 worker
- 「为什么不用 redlock？」→ 休眠维护状态是表象；根本是 Kleppmann 的批评：多节点多数派锁依赖「有界延迟+时钟同步」假设，无 fencing 就不安全；而我们的场景是单 Redis 的**效率型锁**（防重复劳动），正确性交给 DB——分层解决
- 「watchdog 续期为什么用 Lua？」→ GET+PEXPIRE 必须原子：非原子时锁可能在校验与续期间易主，把别人的 TTL 续了
- 「多 agent 接管为什么不用 LangGraph/multi-agent 框架？」→ 调研结论「单 agent+轻编排拿到 95% 收益」；我们的「多员工」是业务层岗位轮转不是技术层 agent 图——用一个 agent loop + 岗位切换实现，复杂度收敛（Illusion of Agentic Complexity 的结论背书）
- 「SSE 为什么经 Redis pub/sub 绕一跳？」→ 生成在 worker 进程 HTTP 在 controller 进程；也换来了 events 断线续传能力
