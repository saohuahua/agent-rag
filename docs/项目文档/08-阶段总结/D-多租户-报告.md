# 任务 D · M4 企业多租户 报告（2026-09-29）

> 独占目录 `apps/api/src/tenant/**` + `apps/api/tests/tenant/**`。未 pnpm add（JWT 纯 HMAC 自签、口令 scrypt，零新依赖）。未 commit/push。未改任何共享文件（prisma.service.ts 只产出补丁见 §5）。

## 1. 交付物清单（对照验收逐条）

| 验收项 | 结果 | 证据 |
|---|---|---|
| EnterpriseContextService ALS run/current/require（契约 §6 签名不变） | ✅ | `enterprise-context.service.ts`；`require()` 无上下文抛 TenantIsolationError |
| member.guard（JWT→Member→挂上下文）+ role.guard（@Roles 层级） | ✅ | `member.guard.ts` 解 cookie/Bearer→查活跃成员→挂 req.tenantCtx；`role.guard.ts` OWNER⊇ADMIN⊇MEMBER |
| auth 注册/登录/JWT cookie（HttpOnly 24h） | ✅ | `auth/*`；注册事务建 User+Enterprise+根部门+OWNER Member；登录选 OWNER 优先 |
| invitation（48h 一次性 token）/ department（物化路径树） | ✅ | `invitation.service.ts` accept 在无上下文作用域执行跨企业建成员；`department.service.ts` path 用 id 改名不动结构 |
| template 状态机 + 审核 + 绑定 | ✅ | DRAFT→PENDING→PUBLISHED 终态不可变 / REJECTED 可改再提交；PUBLISHED 禁 UPDATE |
| package（版本行不可变 同款状态机） | ✅ | `package/*` create/version/submit/publish/reject |
| subscription 锁版本 + provision + 升级 diff | ✅ | 订阅锁「当前已发布最大版本」；升级预览 diff confirm=true 才执行 |
| grant 三层授权解析（企业/部门子树/成员） | ✅ | `grant.service.ts` canUse；部门子树用 path startsWith（含孙部门） |
| audit 统一写入（before/after JSON） | ✅ | `audit.service.ts`；模板/包发布企业 id 传 null 平台级 |
| 隔离矩阵：A 造数→B 断言 0 行/不可见 | ✅ | `tests/tenant/isolation.spec.ts` 覆盖 10 张硬过滤表 + AuditLog |
| 无上下文 require() 抛 TenantIsolationError | ✅ | `tests/tenant/enterprise-context.spec.ts` |

## 2. 12 张租户表的覆盖口径（备案）

扩展硬过滤清单（`prisma-tenant.extension.ts` TENANT_SCOPE）10 张 + 2 张横切表：

- **10 张硬过滤**：Enterprise（按自身 id AND 注入，其余 9 张按 enterpriseId 注入）——Department、Member、Invitation、Subscription、SiliconEmployee、EmployeeGrant、ConversationSession、KnowledgeDataset、KnowledgeDoc
- **AuditLog**（第 11 张）：enterpriseId 可空属横切，不在扩展硬过滤，`audit.service.list()` 显式按当前企业过滤（隔离矩阵有断言）
- **UsageRecord**（第 12 张）：enterpriseId 可空属平台级（00-总览/03 自测题 5 明确「为什么是平台级」），由任务 A 网关写入携带企业 id，D 不硬过滤、由 A 的 budget 测试覆盖——本文备案

## 3. 与文档计划的偏差（已写注释 备案）

1. **ALS 进入拆成「中间件空 box + 守卫 attach」**：Nest 生命周期里中间件先于守卫执行，且 `canActivate` 无法包裹 handler；拦截器方案要 `new Observable` 需直接依赖 rxjs（未在依赖白名单，pnpm 严格不提升）。故 `tenant-context.middleware.ts` 给每个请求先 `run({ctx:null}, next)` 进入空 box，`member.guard` 鉴权成功后 `attach(ctx)` 把上下文写进同一 box（同一对象引用），handler 的 await 诞生在 box 内、扩展读到守卫填好的 ctx。规格「member.guard → ALS enter」行为等价，落点拆成两段（见 `enterprise-context.service.ts` 头注释 why）。
2. **挂载补丁不是 `this.$extends()`**：`$extends` 返回**新实例**（实测 `this !== this.$extends(ext)`），无法原地替换 `this`。正确补丁用 Proxy 转发，见 §5。
3. **无 raw SQL**：部门子树走 ORM `path startsWith`（扩展同时注入 enterpriseId 双重隔离），故 D 无「每条 raw 一个隔离测试」的负担（该约定由 B/J 各自落实）。
4. **findUnique 未重写为 findFirst**：扩展对 findUnique 注入 where（对含企业 id 的复合唯一成立；对仅 id 唯一的模型 Prisma 校验拒绝=fail-closed 不泄漏）。D 自己代码对租户模型一律用 `findFirst`，规避该限制。

## 4. 踩坑实录（面试可讲）

| # | 坑 | 解法 |
|---|---|---|
| 1 | **Prisma 7 模型方法是「延迟 thenable」**：`prisma.model.findMany()` 不立刻执行，`await` 才触发；扩展回调拿不到 ALS store 是因为 `await` 发生在 `run` 回调之外 | ALS 必须让 `await` 落在上下文内：worker/脚本用 `run(ctx, async () => { await prisma... })`；请求链用中间件 `run({ctx:null}, next)` 让 handler 的 async 执行诞生在 box 内、守卫 attach 填充。这是 Prisma 7 相对 6 的行为变化 |
| 2 | `$extends` 返回新实例不能原地挂载到 `extends PrismaClient` 的子类 | Proxy 转发（§5） |
| 3 | `enterprise` 根模型按 id 隔离若直接覆盖 where.id 会把「查 A 企业」误命中成「自己企业」 | id 字段用 `AND: [{ id: ctxId }]` 追加而非覆盖（隔离矩阵有断言） |
| 4 | Prisma 7 可空 Json 字段写 `null` 需 `Prisma.JsonNull` 对象枚举，裸 `null` 编译不过 | 语义「无值」用 `undefined` 省略 |
| 5 | auth.controller ↔ member.guard 共享 AUTH_COOKIE 形成循环导入（CommonJS 下常量拿到 undefined） | 常量移到 member.guard.ts 单向导出 |

## 5. prisma.service.ts 挂载补丁（★ 唯一共享文件例外，用户手动应用）

> 为什么不是规格里的 `this.$extends(tenantExtension)`：该方法返回新客户端实例（不原地改 this），子类构造后无法用返回值替换自身。故用 Proxy 把「模型方法 / $transaction / $connect」全部转发到扩展实例，生命周期方法留在自身，既有 `this.prisma.model.findMany()` 调用点**零改动**。

**改动 1**：文件顶部 import 区新增一行

```typescript
import { tenantExtension } from '../tenant/prisma-tenant.extension'
```

**改动 2**：构造函数体替换为（`super({ adapter })` 之后追加）

```typescript
  constructor(env: EnvService) {
    const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })
    super({ adapter })

    // 挂载租户过滤扩展（D 任务产出）
    // $extends 返回新实例 无法原地替换 this 故用 Proxy 转发模型方法到扩展实例
    // 生命周期方法（onModuleInit/onModuleDestroy）留在自身 其余全部走扩展客户端
    const extended = this.$extends(tenantExtension)
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === 'onModuleInit' || prop === 'onModuleDestroy') {
          return Reflect.get(target, prop, receiver)
        }
        return Reflect.get(extended, prop, extended)
      },
    })
  }
```

补丁效果已单独验证：`instanceof PrismaClient` 语义变化（false，本项目无 instanceof 依赖）、过滤/事务/生命周期全正常。全量 e2e 留任务 J 联调（当前 `nest build` 被 C 的 `runtime/events.service.ts` 类型错误阻塞，非 D 责任）。

## 6. 真实数字

- 新增源码：`src/tenant/**` 17 文件 2275 行（最大单文件 209 行，均 ≤300）
- 测试：`tests/tenant/**` 4 文件 23 用例，全部通过；全仓 `pnpm --filter @agent-rag/api test` 当前 111/111 全绿（含并行任务已落地部分 D 未破坏）
- typecheck：D 范围（src + tests/tenant）0 错误；全量 `tsc --noEmit` 仅剩 C 的 runtime 1 处、B 的 rag 测试 6 处（均为并行任务在制，非 D）
- 无新增依赖：JWT=HMAC HS256（node:crypto）、口令=scrypt 盐随机、cookie 手写解析（不引 cookie-parser）

## 7. 契约变更提案

- **增量导出（不破坏契约）**：TenantModule 除契约 §6 的 `EnterpriseContextService` 外，追加导出 `GrantService`（运行时接管做授权解析）与 `AuditService`（各模块统一写审计）。均为加法，不影响既有签名。
- 无契约签名修改。

## 8. 验收命令

```bash
cd D:\project\agent-A

# ① D 范围测试（隔离矩阵 + 状态机 + 订阅锁版本升级 + 授权三层 + 部门树）
cd apps/api && npx vitest run tests/tenant

# ② 全量测试（含 gateway/rag/smoke，D 未破坏）
pnpm --filter @agent-rag/api test

# ③ D 范围类型检查（全量 tsc 仍被 C/B 在制文件阻塞 属并行任务）
cd apps/api && npx tsc --noEmit

# ④ 应用 §5 挂载补丁后 起服务走 HTTP 演示（审核→订阅→升级→审计）
pnpm --filter @agent-rag/api dev
#   POST /auth/register → 拿 cookie
#   POST /templates/draft → /:id/submit → /:id/publish(ADMIN)
#   POST /packages → /:id/versions → /versions/:id/submit → /versions/:id/publish
#   POST /enterprises/:id/subscriptions {packageId}          # 锁 v1
#   POST /packages/:id/versions … /publish                    # 发 v2
#   GET  /enterprises/:id/subscriptions                        # 老订阅仍 v1
#   POST /subscriptions/:id/upgrade {confirm:false}            # diff 预览
#   POST /subscriptions/:id/upgrade {confirm:true}             # 升级
#   GET  /audit?action=UPGRADE                                 # before/after 留证
```

> 同一全流程的自动化演示已固化在 `tests/tenant/tenant-services.spec.ts`（「审核→订阅锁 v1→发 v2→老订阅不动→confirm 升级→AuditLog before/after」），无需手点即可复现。
