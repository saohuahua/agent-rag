你是「任务 D：企业多租户」的执行会话。工作目录 D:\project\agent-rag。任务 0 已完成。本任务与其他任务并行执行。

# 必读文档
1. docs/10-工程骨架/03-代码规范.md（强制）
2. docs/20-模块实现规格/04-企业多租户.md（★完整规格）
3. docs/10-工程骨架/04-模块间契约.md（§6 EnterpriseContextService 契约）
4. docs/00-总览/03-领域模型与数据库设计.md（§3 行为语义：模板不可变/订阅锁定/epoch 校验/部门子树）

# 你的任务（独占 apps/api/src/tenant/**）
按规格实现：enterprise-context.service（ALS run/current/require）、member.guard（JWT→Member→ALS enter）+role.guard、auth 模块（注册/登录/JWT cookie）、invitation/department（物化路径树）/template 状态机+审核/package/subscription（锁版本+provision+升级 diff）/grant 三层授权解析/audit 统一写入、各 controller。

# 特别注意（唯一的共享文件例外）
prisma-tenant.extension.ts 是你的产出，但要挂载到共享文件 prisma.service.ts 上——**不要直接改共享文件**，把 3 行挂载补丁写在报告里（用户手动应用）。

# 边界
- 只写 apps/api/src/tenant/**；不 pnpm add（bcrypt/jwt 类如未在任务 0 清单内→写申请不自己装：JWT 用 jose 或纯 HMAC 自签实现以避开新依赖，报告里说明选择）；不 commit/push
- 隔离测试套件（§4.8 的隔离矩阵）是本任务验收核心：A 租户造数→B 上下文断言 0 行/404，覆盖 12 张租户表的 ORM 路径

# 验收（规格 §4.9）
两租户并发互不可见（自动化全绿）；审核→订阅锁 v1→发 v2→老订阅不动→confirm 升级→AuditLog before/after 全流程可演示

# 完成动作
报告 docs/08-阶段总结/D-多租户-报告.md（含挂载补丁）；验收命令给用户；契约变更提案如有。
