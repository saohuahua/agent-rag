# 20-05 · 模块规格：前端 Web（E 任务）

> 用户背景是 Vue 前端——本模块是「你的主场」，AI 会话写代码，你负责走读与验收。五段式压缩为：职责 → 页面清单与契约 → 技术要点 → 验收。

## 1. 职责

对话（流式+工具时间线+引用）、知识库（上传+检索测试台）、管理（模板/包/订阅/授权/部门）、运营（成本报表）、登录注册。技术栈：Next 16 App Router + React 19 + `useChat`。

## 2. 页面清单

| 路由 | 页面 | 关键交互 |
|---|---|---|
| `(auth)/login` `/register` | 登录/注册 | 表单+错误态；注册成功自动登录跳 chat |
| `(app)/chat` | 会话列表 + 对话主界面 | **左侧**会话列表（新建时选员工阵容）；**中间**消息流（useChat 打字机）；**右侧**执行时间线（ExecutionEvent 实时滚动：工具调用/接管/降级）；顶部当前员工徽标+可 @ 员工 |
| `(app)/kb` | 数据集/文档管理 | 上传（进度条轮询 doc status）；文档列表（状态徽标含 OCR_NEEDED/FAILED 原因） |
| `(app)/kb/search` | **检索测试台** | 输入查询→双路结果并排（向量路/词法路各自 rank）+ RRF 融合序列可视化（这是讲 RAG 的利器页面） |
| `(app)/admin` | 模板/包/审核 | 模板起草（systemPrompt 编辑+技能/KB 绑定）；提交审核；ADMIN 审核发布；包版本发布 |
| `(app)/admin/subscriptions` | 订阅管理 | 订阅（显示锁定版本）；升级（diff 预览+确认） |
| `(app)/admin/org` | 部门与授权 | 部门树（物化路径渲染）；成员列表；员工授权三 scope |
| `(app)/ops` | 成本报表 | 按日/别名/企业的 usage 汇总表格+简单条形图（无图表库 用 CSS/SVG 手绘——依赖纪律） |

## 3. 与后端的接线（契约）

- 对话：`useChat({ transport: new DefaultChatTransport({ api: 'http://localhost:3002/api/sessions/:id/turns' }) })`——注意 AI SDK 的 transport 把消息 POST 到该 URL，后端返回 UI Message Stream（SSE）。**跨域**：api 开 CORS `origin: http://localhost:3000`；
- 事件时间线：独立 `EventSource('/api/sessions/:id/events')` 订阅 SSE；
- 其余页面普通 REST（fetch 封装一个 `lib/api.ts`：baseURL+credentials:'include'+错误归一化）；
- 认证：JWT HttpOnly cookie（fetch 自动携带）；401 统一跳 login。

## 4. 技术要点（写给 Vue 背景的你）

| Vue 心智 | React 对应 | 备注 |
|---|---|---|
| `ref/computed` | `useState/useMemo` | 依赖数组是最大心智差：Vue 自动追踪 React 手动声明 |
| `watch` | `useEffect([deps])` | 清理函数=onUnmounted |
| slot | children / render props | |
| provide/inject | Context | 后端 ALS 的概念同源 |
| `v-if/v-for` | `&&` / `.map()` | key 语义相同 |

- `'use client'` 只标需要 hooks/交互的组件；页面级尽量 server component 拉初始数据；
- `useChat` 的 `messages` 里 `data-*` part（我们的事件如果走自定义 part）按 AI SDK v7 文档渲染（fallback：事件走独立 SSE 就不依赖 data part）；
- **依赖纪律**：不引 UI 组件库与图表库（Tailwind 可用——加入白名单需用户确认一次：E 任务报告里申请）；样式手写 CSS/Tailwind。

## 5. 文件结构（E 任务独占 `apps/web/`）

```
app/(auth)/{login,register}/page.tsx
app/(app)/layout.tsx（登录态+导航壳）
app/(app)/chat/{page.tsx, components/{SessionList,ChatPanel,Timeline,EmployeeBadge}.tsx}
app/(app)/kb/{page.tsx, search/page.tsx, components/{Uploader,DocTable,DualRecall}.tsx}
app/(app)/admin/{templates,subscriptions,org}/page.tsx + components/
app/(app)/ops/page.tsx
lib/{api.ts, types.ts(从 @agent-rag/shared 导入)}
```

## 6. 验收

- 登录→建会话（选售后侠+扫雷）→流式对话打字机渲染→时间线实时滚动→handover 后员工徽标切换
- 上传 PDF→进度→INDEXED；检索测试台双路 rank 可视化
- 两租户账号各开一个浏览器 profile：互不可见对方数据（前端侧证据）
- `pnpm --filter @agent-rag/web build` 全绿；Lighthouse 无硬伤（可后补）

## 自测题

1. useChat 的 transport 指向哪个 URL？后端返回的流协议叫什么？
2. 事件时间线为什么用独立 EventSource 而不是塞进 useChat 流？（提示：两进程流桥/降级方案）
