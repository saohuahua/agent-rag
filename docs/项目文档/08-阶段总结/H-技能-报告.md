# 任务 H · 技能执行器 报告（2026-09-29）

> 三类异构能力（BUILTIN_FUNCTION / HTTP_RPA / EXTERNAL_AGENT）统一入口的落地。独占 `apps/api/src/skills/**`，全部产出与测试均在本任务目录内，未触碰任何共享契约文件与其它任务目录。

## 1. 交付物清单（对照验收逐条）

| 验收项 | 结果 | 证据 |
|---|---|---|
| 七个 SkillDef（zod schema + 中文设计意图注释） | ✅ | `src/skills/defs/`（kb_search compliance_check batch_scan ticket_classify operate_ticket run_readonly_sql consult_creative_agent）；conversation.handover 按规格归 runtime（C），不在 H |
| SkillExecutorRegistry 按 type 分发三类执行器 | ✅ | `src/skills/skill-executor.ts`：先 zod 校验 → 按 `def.type` 分发；契约签名与桩完全一致（`SkillDef/SkillCtx/EventSink/SkillResult` 未改） |
| kb_search 直调 Retrieval 契约 | ✅ | `executors/builtin/kb-search.ts` 调 `retrieval.hybridSearch`，content 截断 300 字保留来源 |
| compliance 确定性词表引擎（不走 LLM） | ✅ | `executors/builtin/compliance.ts` 读 `corpus/compliance/words.json`（F 产出），纯函数 `matchViolations` |
| ticket_classify 经 gateway 结构化输出 | ✅ | `executors/builtin/ticket-classify.ts` 走 `alias='chat'`，zod 解析失败重试 1 次 |
| readonly-sql 只读白名单 + 单语句校验 + 强制 LIMIT | ✅ | `executors/builtin/readonly-sql.ts` 四道防线：单条 SELECT / 无注释 / 禁 DML 关键词 / 表白名单 orders products refunds + 无 LIMIT 包 `LIMIT 50` + 事务内 `SET LOCAL transaction_read_only = on` |
| http-rpa 通用执行器（10s 超时 + 2 次指数退避 + SKILL_PROGRESS + 计量） | ✅ | `executors/http-rpa.ts` 单文件状态机 |
| external-agent 经 gateway strong-chat 起小 agent | ✅ | `executors/external-agent.ts` 单轮 system 创意角色 + 会话摘要注入 + EXTERNAL_AGENT 计量 |
| errors.ts 三个错误类 | ✅ | `SkillInputError`（带 issues 透出）`SkillTimeoutError` `RpaError`，均带 `code` |
| 每个 skill 合法/非法输入测试 | ✅ | `tests/skills/defs.spec.ts` 7 技能 × 合法 + 非法 |
| RPA 重试序（mock 500 两次→成功） | ✅ | `tests/skills/http-rpa.spec.ts` 断言 3 次请求 + phase 序 `scanning request retry request retry request done` + 退避 `[1000,4000]` |
| readonly-sql 安全测试组（DROP/多语句/白名单外表全拒） | ✅ | `tests/skills/readonly-sql.spec.ts` 覆盖 DROP / DELETE / 分号多语句 / SELECT INTO / 注释 / 非 SELECT / users 表 / JOIN 外表 |
| 事件 emit 参数正确 | ✅ | `http-rpa.spec.ts` 断言 SKILL_PROGRESS phase/attempt/delayMs/batch 与 SKILL_WRITE（riskLevel=2） |

## 2. 真实数字

- 测试：**60/60**（5 个文件）全绿；全仓 `vitest run` **171/171**（27 文件）通过，本任务未破坏任何既有测试
- 类型检查：`tsc --noEmit`（src 范围）**0 错误**（见 §6 已知跨任务问题）
- 文件：7 defs + 6 执行器 + registry + errors + module，共 1249 行
- 词表：读取 `corpus/compliance/words.json` 199 词（severe 47 / high 149 / medium 3，F 已诚实标注 <300）

## 3. 与文档计划的偏差（已写注释 备案）

1. **MOCK_RPA_URL 直接读 `process.env`**：规格 §3 要求「从 env MOCK_RPA_URL 读」，但 `EnvService`（`config/env.service.ts`）不归 H 维护、无法加 getter，且代码规范 §12「环境变量经 EnvService」是软性建议。故在 `http-rpa.ts` 用 `process.env.MOCK_RPA_URL || 'http://localhost:3002'` 兜底并注释原因，报告 §6 提案补 EnvService getter。
2. **端口 3002 vs 3003**：20-规格/06 写「mock-rpa:3002」，但 `.env` 是 `MOCK_RPA_PORT=3003`、G 任务的 `mock-rpa/server.ts` 实际监听 3003。H 按规格默认 3002，集成期（J）须二选一对齐，建议统一在 `.env` 加 `MOCK_RPA_URL=http://localhost:3003`。
3. **RPA 端点不一致**：规格 §2 写 `POST /scan` 与 `POST /tickets/:id/operate`，但 G 已落地的 mock-rpa 是 `/tickets/:id/transition` 与 `/tickets/batch/tag|refund`。H 严格按规格实现 `/scan`、`/tickets/:ticketId/operate`（configJson.endpoint 可覆盖），集成期需与 G 对齐端点名。
4. **kb_search 的 datasetId 只能透出不能过滤**：规格 §2 说「configJson 注入 datasetId 限定范围」，但 `RetrievalService.hybridSearch` 契约（10-04 §4）只有 `enterpriseId` 无 datasetId 参数。H 把 datasetId 解析后放进 output 供追溯，实际隔离仍是 enterpriseId 级，报告 §6 提案契约扩展。
5. **external-agent 双账**：规格 §1 说外部 agent 直连 OpenAI 兼容端点、§2 又说经 gateway strong-chat。H 按 §2 走 gateway（复用降级+计量），H 显式记 `kind=EXTERNAL_AGENT`（成本 0 只记次数/延迟），底层 LLM token 由 gateway 内部记 `kind=LLM`——两条账不同维度，不冲突。
6. **测试落点**：测试放 `apps/api/tests/skills/`（vitest include 只扫 `tests/**`，与 B/C/D 的 tests/rag|runtime|tenant 同构），非 `src/skills/` 内。

## 4. 三类执行器不变量（面试可讲）

| 执行器 | 不变量 | 落地处 |
|---|---|---|
| BUILTIN_FUNCTION | 进程内确定性、可复现、不计量 | compliance 词表逐字命中；readonly-sql 白名单静态校验 |
| HTTP_RPA | 外部副作用必有事件 + 计量 | 每次尝试 SKILL_PROGRESS；riskLevel≥2 记 SKILL_WRITE；meter.record kind=RPA |
| EXTERNAL_AGENT | 上下文注入隔离 + 计量 | 单轮 system 角色 + sessionId/employeeId/templateSlug 注入；meter.record kind=EXTERNAL_AGENT |

关键决策注释（面试答案）：
- **readonly-sql 为什么两道防线**：静态校验（白名单/单语句）是主证据，事务内 `SET LOCAL transaction_read_only` 是兜底——防静态校验漏网；用 `transaction_read_only` 而非规格字面的 `default_transaction_read_only`，因为后者是会话级默认值，Prisma 连接池复用会话会残留只读态污染其它请求，事务级 `SET LOCAL` 只影响当前事务。
- **RPA 为什么 4xx 不重试、5xx/网络错/超时才重试**：4xx 是参数/权限错，重试同样错；5xx 是对方资源问题，退避重试有意义。
- **compliance 为什么 contains 而非分词**：中文无天然词边界，词表含单字「最」这类绝对化语素，子串命中即违规。

## 5. 踩坑实录

| # | 坑 | 解法 |
|---|---|---|
| 1 | zod v4 `z.record` 签名从 1 参改为 2 参（`z.record(value)` → `z.record(key, value)`），1 参直接编译报错 | 改为 `z.record(z.string(), z.array(...))` |
| 2 | vitest fake timer 下，超时测试的 `p` 在 `runAllTimersAsync` 期间先拒绝、断言后才挂 `.rejects`，产生 unhandled rejection 警告 | 先 `const assertion = expect(p).rejects...` 挂好断言，再推定时器 |
| 3 | 执行器目录层级不同导致相对路径错（`executors/` 与 `executors/builtin/` 差一层） | 逐一核对相对导入，builtin 用 `../../`、executors 直级用 `../` |

## 6. 契约变更提案（供用户裁决）

1. **`RetrievalService.hybridSearch` 增加可选 `datasetId?`**：kb_search 才能做到 dataset 级隔离。影响面：B 实现 + H kb-search 传参。当前 H 已把 datasetId 透出到 output 占位。
2. **`EnvService` 增加 `get MOCK_RPA_URL()`**：统一环境变量出口。影响面：仅 env.service.ts（任务 0 持有）+ H 改回注入。当前 H 用 `process.env` 兜底已注释备案。
3. **统一 mock-rpa 端口与端点**：建议 `.env` 加 `MOCK_RPA_URL=http://localhost:3003`，并让 G 的 mock 提供 `/scan` 与 `/tickets/:id/operate`（或 H 改默认路由与之对齐）。由 J 集成期裁决。

## 7. 已知跨任务问题（非 H 范围）

- `pnpm --filter @agent-rag/api typecheck` 的第二段 `tsc -p tsconfig.prisma.json` 会在 **B 任务**的 `tests/rag/retrieval.spec.ts` 报 6 个 `mockResolvedValue` 类型错误（mock 对象被标成了真实签名）。H 未改动该文件，属 B 待修；H 自身 `tsc --noEmit`（src）与 tests/skills 均 0 错误。
