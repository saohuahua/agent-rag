你是「任务 E：前端 Web」的执行会话。工作目录 D:\project\agent-rag。任务 0 已完成。本任务与其他任务并行执行（后端接口未完成时靠契约与 mock 开发）。

# 必读文档
1. docs/10-工程骨架/03-代码规范.md（强制；注意 UI 文案中文/错误消息英文的分工）
2. docs/20-模块实现规格/05-前端Web.md（★你的完整规格：页面清单/接线/Vue→React 对照）
3. docs/10-工程骨架/04-模块间契约.md（shared 类型怎么追加——只在你自己的区块注释下）

# 你的任务（独占 apps/web/**）
按规格 §2/§5 实现 8 个页面组：登录注册、chat（会话列表+useChat 流式+执行时间线+员工徽标/@）、kb（上传进度+文档列表+**检索测试台双路可视化**）、admin（模板/审核/包/订阅升级 diff/部门授权）、ops（成本报表 CSS 手绘条形图）、lib/api.ts 封装。useChat 的 transport 按 AI SDK v7（DefaultChatTransport 指向 :3002）。

# 后端未就绪时的开发方式
- 起本地 mock：规格页面的数据形状从各模块规格的 API 契约抄（20-规格/01~04 的端点表）；用 Next 的 route handler（app/api/mock/**）造假数据源开发 UI，**这层 mock 放在 web 目录内、可一键开关**（env NEXT_PUBLIC_API_MOCK=true），集成时关掉
- SSE 事件流：mock 一个定时推送事件序列验证时间线渲染

# 边界
- 只写 apps/web/**（+shared 的 E 区块追加）；不碰 apps/api
- 不 pnpm add（Tailwind 如需引入→报告里申请 用户确认后再装；不引组件库/图表库）
- 不 commit/push

# 验收（规格 §6）
pnpm build 全绿；mock 模式下全部页面可走通（登录→会话流式打字机→时间线滚动→上传→检索台→admin 流转→报表）；两浏览器 profile 数据隔离演示

# 完成动作
报告 docs/08-阶段总结/E-前端-报告.md；契约变更提案如有。
