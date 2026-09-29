# 任务 E · 前端 Web 报告（2026-09-29）

> 执行会话：任务 E 独占 `apps/web/**` + `packages/shared` 的 E 区块追加。后端 B/C/D/H 未就绪，全部页面经 Next route handler（`app/api/mock/**`）造假数据开发，`NEXT_PUBLIC_API_MOCK=true` 一键切换。未 commit / 未 push / 未 `pnpm add`。

## ① 交付物清单（对照验收逐条）

| 验收项 | 结果 | 证据 |
|---|---|---|
| `pnpm --filter @agent-rag/web build` 全绿 | ✅ | 28 页面 + 34 mock API 路由全部产出，`Running TypeScript` 0 错误（报告 §2 附路由清单） |
| 登录→建会话（选售后侠+扫雷）→流式打字机→时间线实时滚动→handover 后徽标切换 | ✅ | curl 冒烟：登录写 cookie→`POST /sessions` 建会话→`POST /sessions/:id/turns` SSE 逐字增量；handover 触发后 `currentParticipantId` 1→2，events SSE 回放出 `TAKEOVER emp1→emp2`（§2） |
| 上传 PDF→进度轮询→INDEXED；检索测试台双路 rank 可视化 | ✅ | `POST /kb/datasets/:id/docs`（multipart）→`GET /kb/docs/:id` 按时间推进 UPLOADED→QUEUED→PARSING→INDEXED；`POST /kb/search` 返回每项 vectorRank/lexicalRank/rrfScore，`DualRecall.tsx` 三列并排 |
| 两租户账号互不可见对方数据（前端侧证据） | ✅ | 两 cookie jar 分别登录 owner1/owner2，`/sessions`、`/kb/datasets` 返回各自租户数据（§2） |
| 8 页面组 | ✅ | `(auth)/login` `(auth)/register` `(app)/chat` `(app)/kb` `(app)/kb/search` `(app)/admin/templates` `(app)/admin/subscriptions` `(app)/admin/org` `(app)/ops` |
| useChat 走 AI SDK v7 DefaultChatTransport 指向 :3002 | ✅ | `ChatPanel.tsx` `new DefaultChatTransport({ api: chatTurnUrl(session.id) })`；`chatTurnUrl` 真实模式拼 `NEXT_PUBLIC_API_BASE_URL`（默认 `http://localhost:3002`） |
| lib/api.ts baseURL+credentials+错误归一化+401 跳登录 | ✅ | `apps/web/lib/api.ts` |
| mock 一键开关 | ✅ | `NEXT_PUBLIC_API_MOCK=true`（`.env.local` 已 gitignore，`.env.example` 备案） |

### 文件清单（本次产出）

```
apps/web/
  app/layout.tsx  app/globals.css
  app/(auth)/login/page.tsx  app/(auth)/register/page.tsx
  app/(app)/layout.tsx（登录态导航壳）
  app/(app)/chat/page.tsx + components/{SessionList,ChatPanel,Timeline,EmployeeBadge}.tsx
  app/(app)/kb/page.tsx + kb/search/page.tsx + components/{Uploader,DocTable,DualRecall}.tsx
  app/(app)/admin/{templates,subscriptions,org}/page.tsx + admin/page.tsx（redirect）
  app/(app)/ops/page.tsx
  lib/{api.ts,auth.tsx,types.ts}
  app/api/mock/_lib/{store.ts,http.ts}（内存库 + 响应辅助）
  app/api/mock/**/route.ts（auth/employees/sessions/kb/skills/templates/packages/subscriptions/departments/members/grants/admin 共 34 个路由）
packages/shared/src/index.ts（仅 web 区追加 DTO 类型 未动别人区块）
```

## ② 真实数字

- 构建：`next build`（Turbopack）编译 1.3s，TypeScript 2.0s，静态生成 28 页 908ms；`pnpm --filter @agent-rag/shared build`、`pnpm --filter @agent-rag/web typecheck`、`pnpm --filter @agent-rag/shared typecheck` 全 0 错误
- 冒烟（`next start -p 3100` 后 curl）：
  - `owner1@demo.com` → `{"enterpriseId":1,"enterpriseName":"美妆严选",...}`；`owner2@demo.com` → `{"enterpriseId":2,"enterpriseName":"数码极客",...}`
  - 隔离：owner1 `/sessions` 只返回「退货流程咨询」（员工 1/2）；owner2 只返回「手机保修咨询」（员工 4）；`/kb/datasets` owner1=2 个、owner2=1 个，互不可见
  - handover：发「这个宣传语合规吗 帮我扫雷」→ 流内先售后侠再扫雷官两段正文，events SSE 序列 `TURN_START→SKILL_START(kb_search)→SKILL_END→TAKEOVER(1→2)→SKILL_START(compliance_scan)→SKILL_END→TURN_END`，会话 `currentParticipantId` 由 1 变 2

## ③ 踩坑记录（问题→原因→解决）

| # | 问题 | 原因 | 解决 |
|---|---|---|---|
| 1 | 相对 import 大面积 module-not-found | `lib/api` 在 `apps/web/lib` 而非 `apps/web/app/lib`；route handler 的 `_lib` 深度随目录层级各不同（1~5 层） | 逐文件按目录层级修正相对路径（`ChatPanel/Timeline` 4 层、`kb/docs/[id]` 3 层、`publish` 5 层等） |
| 2 | mock 种子数据 id 混乱 | 企业 2 硬编码 `10/11/12` 与 `nextId` 自增冲突，导致 grant/会话引用不存在员工 | 企业 2 改为捕获 `nextId` 返回值；注册新企业 `db.seq['enterprise']=2` 起避免撞种子企业 1/2 |
| 3 | 手测 handover 不触发 | Windows Git Bash 的 curl 内联中文被编码打乱，服务端收到的 message 乱码、正则不命中 | 浏览器无此问题；命令行验证改 UTF-8 JSON 文件 `--data-binary @file` |
| 4 | useChat 默认请求体与后端契约不符 | AI SDK v7 `DefaultChatTransport` 默认 POST `{messages,id}`，后端契约（03 §4.5）是 `{message}` | 用 `prepareSendMessagesRequest` 把 body 压成 `{ message: lastUserText }`（见契约变更提案 2） |
| 5 | Next 16 自动改写 tsconfig | Turbopack 要求 `jsx:react-jsx`/`isolatedModules` | 属正常必要改动，保留 Next 注入项 |

## ④ 契约变更提案（需用户裁决）

1. **API 前缀**：05 规格 §3 写 `http://localhost:3002/api/sessions/:id/turns`，但 Nest 现状（main.ts / healthz / 各 controller）无全局 `/api` 前缀，实际是 `/sessions`。前端统一收敛到 `lib/api.ts` 的 `NEXT_PUBLIC_API_BASE_URL` 常量，路径无 `/api` 前缀。若后端将来加全局前缀，改一处即可。
2. **turn 请求体**：useChat transport 默认体是 `{messages,id}`，与 03 §4.5 `{message}` 不一致，前端已用 `prepareSendMessagesRequest` 压成 `{message}`。建议 C 任务实现 `POST /sessions/:id/turns` 时按 `{message}` 收参（前端已对齐），或明确改收 AI SDK 原始体。
3. **缺失端点**：前端需要的 `GET /employees`（会话选阵容/@ 提及）与 `GET /kb/datasets/:id/docs`（文档列表）在 03/04 规格未显式列出，前端已按语义 mock，建议 C/D 任务实现同语义端点。
4. **检索返回包一层**：`POST /kb/search` 前端约定返回 `{ hits, channel }`，`hits` 即契约 `RetrievalHit[]`（双路 rank + rrfScore 字段够用）。
5. **依赖纪律备案**：未引入 Tailwind/UI 库/图表库，纯手写 CSS + 手绘条形图，故**无需 Tailwind 白名单申请**。

## ⑤ 给用户的学习讲解提纲

建议按序讲给面试官（结合你是 Vue 背景，先把心智模型对齐）：

1. **Vue→React 对照**（05 §4）：`ref/computed→useState/useMemo`、`watch→useEffect`、`provide/inject→Context`、`v-if/v-for→&&/.map`。本项目 `lib/auth.tsx` 的 AuthProvider 就是 Context 一次实战。
2. **AI SDK v7 useChat 的 transport 模型**：不再传 `api` 字符串，而是 `new DefaultChatTransport({ api, prepareSendMessagesRequest })`；`messages` 是 `UIMessage[]`（parts 数组），`sendMessage({text})` 取代老 `handleSubmit`。
3. **UI Message Stream 协议**（wire format）：`start→start-step→text-start→text-delta*→text-end→finish-step→finish`，逐 delta 即打字机。mock 的 `turns/route.ts` 是这份协议的最小可读实现。
4. **时间线为什么独立 EventSource**（自测题 2 答案）：useChat 流只承载文本增量，工具调用/接管/降级事件在 worker 进程产生、经 pub/sub 转 events SSE，两进程流桥 + 断线续传（`?afterId=`）。前端 `Timeline.tsx` 用事件 id 去重应对重连重放。
5. **RRF 双路可视化**：`DualRecall.tsx` 把向量路/词法路各自名次并排，融合只按名次 `1/(60+rank)`——这是讲「中文 RAG 双路互补」最直观的一页。
6. **租户隔离的前端证据**：cookie→enterpriseId→所有 mock 查询按租户过滤，两浏览器 profile 天然隔离，对应真实后端 ALS+Prisma 行过滤。
7. **物化路径部门树**：`buildDeptTree` 把 `path='/1/2/4/'` 平铺列表重组成嵌套树；订阅锁定版本升级 diff 的 `added/removed/changed` 计算在 `subscriptions/[id]/upgrade`。
