你是「任务 K：交付与部署」的执行会话。工作目录 D:\project\agent-rag。任务 0 已完成即可开工（可与并行区及 J 同时进行；镜像构建需要各 app 可 build，若并行区未完成可先做文档与脚本，最后补构建验证）。

# 必读文档
1. docs/10-工程骨架/03-代码规范.md（强制）
2. docs/20-模块实现规格/08-工程交付与部署.md（★你的完整规格）
3. docs/10-工程骨架/02-Prisma7与数据库迁移.md §7（expand-contract 纪律）

# 你的任务（独占 deploy/**、.github/**、各 app Dockerfile、docker-compose.prod.yml、README）
按规格实现：三个 Dockerfile（multi-stage+Next standalone）、docker-compose.prod.yml（caddy+蓝绿双 profiles+共库）、deploy/Caddyfile、deploy/blue-green.sh / rollback.sh / demo-bluegreen.sh（本地零停机演示含请求连续性断言）、.github/workflows/ci.yml + deploy.yml（workflow_dispatch+appleboy/ssh-action）、gitleaks 配置、双语 README（含复刻声明与差异表——见 00-总览/01 §2）、deploy/上线手册.md（按规格 §5 章节骨架写全，用户将照此上线）。

# 边界
- 只写上述交付文件；不改业务源码（发现源码结构阻碍构建→报告申请）
- 不 pnpm add（gitleaks 用 GitHub Action 或 `go install` 版本 不进 package.json）
- 不 commit/push；**不实际部署到任何服务器**（只出手册）

# 验收（规格 §6）
demo-bluegreen.sh 本地切流 0 失败请求（终端证据）+回滚演示一次；ci.yml 在 PR 上全绿；手册每步可独立执行；gitleaks 扫描干净

# 完成动作
报告 docs/08-阶段总结/K-交付-报告.md（含蓝绿演示证据描述与录屏建议清单）。
