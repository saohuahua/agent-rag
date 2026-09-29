# 10-01 · Monorepo 与开发环境（无 Docker 版）

> 任务 0（基座）的**精确产出清单**：目录树、根配置、依赖全集、环境变量。后续所有并行任务在此基础上只动自己目录。
> **本机无 Docker**（2026-09-29 实测验证过的替代方案）：Postgres = PGlite（npm 内嵌 Postgres + pgvector）+ socket 线协议服务；Redis = Windows 原生二进制（本机已装 Redis 8.10.1）。

## 0. 本地基础设施方案（为什么 + 已验证结论）

| 组件 | 本地方案（开发） | 已验证（2026-09-29 本机 spike） | 生产（VPS） |
|---|---|---|---|
| PostgreSQL | **PGlite**（@electric-sql/pglite）+ **pgvector 扩展**（@electric-sql/pglite-pgvector）+ **socket 服务**（@electric-sql/pglite-socket，把 PGlite 暴露成 127.0.0.1:5432 的标准 Postgres 线协议） | ✅ vector(3)/`<=>`/HNSW 索引/tsvector+GIN+ts_rank/事务回滚 全通过；✅ pg 客户端普通查询/向量查询/参数化事务/**并发连接+连接池**全通过（maxConnections 需显式设 ≥池大小，默认 1 会踢第二个连接——坑已踩并记录） | Docker `pgvector/pgvector:pg17`（K 任务） |
| Redis | **Windows 原生 redis-server**（本机已有：winget 的 redis-windows-fork 8.10.1，PATH 可用） | ✅ SET NX PX / Lua 脚本 / PONG 全通过 | Docker `redis:7-alpine`（K 任务） |

**架构叙事（面试可讲）**：开发环境零 Docker 依赖（嵌入式 Postgres + 原生 Redis，新机器 clone 即跑）；生产仍是标准 Docker Compose——**开发/生产同协议不同载体**，因为 socket 层让 PGlite 在网络协议上与真 Postgres 完全同构（pg/Prisma 无感知）。

**PGlite 的已知限制（写进文档的诚实条款）**：
1. 单数据库（不支持 CREATE DATABASE）→ **本地无法用 `prisma migrate dev`**（需要 shadow database）→ 本地迁移走自研 runner（见 10-骨架/02），生产用 `prisma migrate deploy` 跑同一批迁移文件；
2. 所有查询经全局队列串行执行（QueryQueueManager）→ 个人项目量级无感知，高并发场景不适用（文档如实写）；
3. 性能低于原生 PG（WASM）→ 检索/评测的**相对数字**（消融对比）仍有效，**绝对延迟**生产环境另测。

## 1. 目录树（任务 0 建成后固定不变）

```
agent-rag/
├─ pnpm-workspace.yaml                 # apps/* packages/*
├─ package.json                        # 根脚本（见 §3）
├─ .env / .env.example                 # 密钥模板（真实 .env 不进 git）
├─ .gitignore                          # 含 data/（PGlite 数据目录）
├─ docs/                               # 本文档体系
├─ prompts/                            # 并行执行 prompt 包
├─ corpus/                             # 语料（F 任务独占）
├─ scripts/
│  ├─ infra-up.mjs                     # ★任务0：起 PGlite socket(5432)+Redis(6379) 后台进程（pid 文件管理）
│  ├─ pg-server.mjs                     # ★任务0：PGlite 长驻服务（infra-up 派生）
│  ├─ infra-down.mjs                    # ★任务0：按 pid 文件停
│  └─ （demo-*/eval 入口归 J 任务 K 的交付物在 deploy/）
├─ .github/workflows/                  # K 任务独占
├─ apps/
│  ├─ api/                             # NestJS 12（唯一后端）
│  │  ├─ package.json                  # ★ 全量依赖任务 0 一次装齐（§4），并行任务禁改
│  │  ├─ tsconfig.json / nest-cli.json
│  │  ├─ prisma/
│  │  │  ├─ schema.prisma              # ★ 26 表全量（00-总览/03 canonical），并行任务禁改
│  │  │  ├─ migrations/000_init/       # ★ 迁移 SQL（DDL+pgvector HNSW+GIN，见 10-骨架/02）
│  │  │  ├─ migrate-local.mjs          # ★ 自研本地迁移 runner（按序执行 migrations/*.sql）
│  │  │  └─ seed.ts                    # 平台级种子
│  │  └─ src/
│  │     ├─ main.ts / app.module.ts    # ★ 注册全部子模块（任务 0 建好，并行任务禁改）
│  │     ├─ config/env.ts              # zod 环境变量校验
│  │     ├─ prisma/                    # PrismaService（全局）
│  │     ├─ common/                    # 错误类/契约接口（公共小件，先建后锁）
│  │     ├─ gateway/                   # A 任务独占（M1）
│  │     ├─ rag/                       # B 任务独占（M2）
│  │     ├─ runtime/                   # C 任务独占（M3）
│  │     ├─ skills/                    # H 任务独占（技能执行器）
│  │     ├─ tenant/                    # D 任务独占（M4）
│  │     └─ （每个目录任务 0 预置：module 文件 + 契约接口桩，见 10-骨架/04）
│  ├─ web/                             # E 任务独占（Next 16）
│  └─ mock-rpa/                        # G 任务独占：mock 工单系统
└─ packages/shared/                    # 前后端共享 zod DTO（任务 0 建骨架+基础类型）
```

**★ 标记 = 共享文件，只在任务 0 创建/修改**（scripts/infra-*.mjs 与 prisma/migrate-local.mjs 归任务 0；scripts/ 其余文件归 J/K）。并行任务纪律见 prompts/README。

## 2. 基础设施进程管理（infra-up.mjs 规格）

```javascript
// 核心行为（任务 0 实现 中文注释按代码规范）：
// 1 PGlite: new PGlite('data/pglite', { extensions: { vector } })
//   先执行 CREATE EXTENSION IF NOT EXISTS vector（幂等）
// 2 PGLiteSocketServer({ db, port: 5432, host: '127.0.0.1', maxConnections: 32 })
//   maxConnections 必须 ≥ Prisma pg Pool 大小 默认 1 会拒绝第二个连接（已踩坑）
// 3 Redis: spawn('redis-server', ['--port', '6379'], { detached: true, stdio: 'ignore' })
//   PATH 找不到 redis-server 时报错并提示 winget install（见下）
// 4 两个进程的 pid 写 data/*.pid 供 infra-down 停止（Windows taskkill /PID /F）
// 5 已在运行（端口被占）时幂等跳过并提示
```

Redis 不在 PATH 的机器：`winget install taizod1024.redis-windows-fork`（用户机器已装，新机器写进 README）。

## 3. 根 package.json 脚本

```json
{
  "scripts": {
    "dev": "pnpm --parallel -r run dev",
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "typecheck": "pnpm -r run typecheck",
    "db:up": "node scripts/infra-up.mjs",
    "db:down": "node scripts/infra-down.mjs",
    "db:migrate": "pnpm --filter @agent-rag/api db:migrate",
    "db:seed": "pnpm --filter @agent-rag/api db:seed",
    "eval:rag": "pnpm --filter @agent-rag/api eval:rag",
    "demo:scenario": "pnpm --filter @agent-rag/api demo:scenario"
  },
  "packageManager": "pnpm@11.23.0",
  "engines": { "node": ">=22.12" }
}
```

## 4. 依赖全集（任务 0 一次装齐，并行任务禁新增）

**根 package.json devDependencies**（scripts/ 基础设施脚本专用）：`@electric-sql/pglite @electric-sql/pglite-pgvector @electric-sql/pglite-socket`
**apps/api**：`@nestjs/common @nestjs/core @nestjs/platform-express @nestjs/bullmq bullmq ioredis ai @ai-sdk/openai-compatible @ai-sdk/deepseek @prisma/client @prisma/adapter-pg pg zod pdf-parse mammoth @node-rs/jieba`；dev：`typescript tsx @nestjs/cli prisma vitest @nestjs/testing @types/express @types/node`
**apps/web**：`next react react-dom ai @ai-sdk/react zod`；dev：`typescript @types/react @types/react-dom`
**packages/shared**：`zod` + `typescript`——**构建为 dist**（`pnpm --filter @agent-rag/shared build`；main/types 指向 dist。改 shared 源码后必须重跑 build，api/web 才能看到新类型）
**apps/mock-rpa**：`hono @hono/node-server zod` + `tsx typescript`
**Prisma 必须 pin `@^7.10`**（npm latest 是 8.0-RC，已踩坑）

**新增依赖的唯一合法路径**：任务报告里写明理由 → 用户确认 → 用户手动加。理由：并行会话同时 `pnpm add` 会互相打架损坏 lockfile。

## 5. 环境变量（.env.example）

```bash
# PGlite socket 服务（infra-up.mjs 起在 5432）
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
# Windows 原生 Redis（infra-up.mjs 起在 6379）
REDIS_URL=redis://127.0.0.1:6379
DEEPSEEK_API_KEY=
SILICONFLOW_API_KEY=
API_PORT=3002
# mock 工单系统
MOCK_RPA_PORT=3003
# P4 起
JWT_SECRET=
```

env 校验：`src/config/env.ts` 用 zod parse `process.env`，缺必填项启动即失败并列出缺失清单（fail-fast）。

## 6. 任务 0 的验收清单

- [ ] `pnpm install` 全绿（一次装齐 §4 全部依赖）
- [ ] `pnpm db:up` 后 5432/6379 都在监听；`pnpm db:down` 能干净停止
- [ ] `pnpm db:migrate`（自研 runner）成功：psql/pg 查询 26 张表存在 + `SELECT * FROM pg_extension WHERE extname='vector'` 有行
- [ ] `pnpm --filter @agent-rag/api dev` 启动，`GET /healthz` 200（db+redis ping）
- [ ] 所有契约接口桩存在且可编译（桩函数 throw new Error('NOT_IMPLEMENTED')）
- [ ] `pnpm typecheck` 全绿；`pnpm test`（空测试套）绿
- [ ] seed 脚本可跑：model_providers 2 行、model_routes ≥3 行、skills 8 行、模板 6 行
- [ ] git 首次 commit（`任务0: 基座就绪`）

## 自测题

1. 为什么所有依赖必须在任务 0 一次装齐？
2. PGlite 的 socket 服务和真 Postgres 在网络层是什么关系？为什么 Prisma/pg 完全无感知？
3. `maxConnections` 默认值是多少？不设置会发生什么？（本机踩过的坑）
