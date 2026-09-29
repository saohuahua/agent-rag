# 10-02 · Prisma 7 与数据库迁移工作流（本地无 Docker / 生产 Docker 双轨）

> Prisma 7 新架构 + 本地 PGlite（单库无 shadow database）→ **本地自研迁移 runner，生产官方 migrate deploy，跑同一批迁移文件**。任务 0 执行；后续任务只读不改。

## 1. Prisma 7 架构变化（与网上旧资料的关键差异）

| 变化点 | 旧版（≤6） | Prisma 7 | 影响 |
|---|---|---|---|
| 查询引擎 | Rust 二进制 | **无引擎，driver adapter** | 必须装 `@prisma/adapter-pg`，PrismaService 构造时传入 |
| schema datasource | 含 `url = env(...)` | **不写 url** | 连接串运行时给 adapter；CLI 走 prisma.config.ts |
| generator | `prisma-client-js` | `prisma-client` | 产出 TS 代码到 `src/generated/prisma`（gitignore，构建前 `prisma generate`） |
| 配置文件 | 无 | `prisma.config.ts`（`defineConfig` from `prisma/config`） | schema 路径、迁移路径、seed 命令都在这 |

## 2. 双轨迁移设计（为什么本地不用 migrate dev）

- `prisma migrate dev` 需要 **shadow database**（临时 CREATE DATABASE 对比 schema）——PGlite 是**单数据库**不支持 CREATE DATABASE → 本地不可用；
- 方案：**迁移 SQL 文件是唯一真相**，本地用自研 runner 按序执行，生产（真 Postgres）用官方 `prisma migrate deploy` 执行同一批文件。文件夹命名遵守 Prisma 规范（`<timestamp>_<name>/migration.sql`），生产 deploy 时能直接采用。
- 面试讲点：「为什么自研 runner」= PGlite 单库限制 + 60 行代码换来双轨一致性，且 runner 本身就是可讲的小工程（顺序、幂等、事务包裹）。

## 3. 文件落点

```
apps/api/
├─ prisma.config.ts          # defineConfig({ schema, migrations: { path, seed }, datasource: { url: env } })
├─ prisma/schema.prisma      # 00-总览/03 的 canonical schema 原样落盘
├─ prisma/migrations/
│  └─ 000000000000_init/migration.sql   # 任务 0 生成（§5 流程）+ 手写增强（§6）
└─ prisma/migrate-local.mjs  # 自研 runner（§4）
```

## 4. 自研迁移 runner 规格（migrate-local.mjs）

```javascript
// 行为（任务 0 实现）：
// 1 连 DATABASE_URL（pg 直连 socket 层）
// 2 建簿记表 IF NOT EXISTS _local_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ)
// 3 扫 migrations/*/migration.sql 按目录名排序
// 4 未应用的：整个文件包在一个事务里执行（BEGIN...COMMIT 失败回滚退出非零）
// 5 幂等：重跑只应用新文件；输出「applied: xxx / skipped: n」
// 约 60 行 pg 代码 中文注释按代码规范
```

## 5. 初始迁移 SQL 的生成（任务 0 流程，2026-09-29 spike 已验证）

```bash
cd apps/api
# 离线生成（不连库 不需要 shadow database）——注意 Prisma 7 的旗标是 --to-schema（旧资料写 --to-schema-datamodel 已废弃）
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script -o prisma/migrations/000000000000_init/migration.sql
# Prisma 7 新 generator 会把 Unsupported("vector")/Unsupported("tsvector") 直接生成进 CREATE TABLE（实测）
# 然后按 §6 手写追加（必须！见「维度坑」）再应用
pnpm db:migrate   # 自研 runner 应用到本地 PGlite
```

**版本坑（已踩）**：npm 的 `prisma` latest 已指向 **8.0.0-RC**（CLI 命令结构大变，`migrate` 都没了）——**必须显式安装 `prisma@^7.10 @prisma/client@^7.10 @prisma/adapter-pg@^7.10`**。

## 6. 手工追加的 SQL（Prisma 表达不了的部分）

```sql
-- ========== 向量与全文检索（手写区） ==========

CREATE EXTENSION IF NOT EXISTS vector;

-- ★维度坑（2026-09-29 spike 实测）：Prisma 生成的 DDL 是裸 vector 无维度
-- pgvector 的 HNSW 索引要求列带维度 否则报 column does not have dimensions（hnswbuild.c InitBuildState）
-- 必须先 ALTER 出维度再建索引
ALTER TABLE "knowledge_chunks" ALTER COLUMN "embedding" TYPE vector(1024);

-- HNSW 索引（bge-m3 固定 1024 维 余弦距离）
CREATE INDEX "knowledge_chunks_embedding_hnsw"
  ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- 词法列索引：应用层 jieba 分词后的空格串 → simple 配置 tsvector + GIN
CREATE INDEX "knowledge_chunks_tsv_gin" ON "knowledge_chunks" USING gin ("tsv");
```

（PGlite 首次启动时 infra-up 已执行过 CREATE EXTENSION vector，这里幂等再保险；生产 PG 走 compose 镜像自带扩展，同样幂等。）

## 7. 运行时注入（PrismaService）

```ts
// apps/api/src/prisma/prisma.service.ts 形态
import { PrismaPg } from '@prisma/adapter-pg'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(env: EnvService) {
    // adapter 底层是 pg Pool 连 socket 层的 PGlite（对 pg 无感知）
    const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })
    super({ adapter })
  }
  async onModuleInit() { await this.$connect() }
  async onModuleDestroy() { await this.$disconnect() }
}
// main.ts: app.enableShutdownHooks() 必须开 否则 onModuleDestroy 不触发
```

## 8. 写入与查询统一口径（所有模块遵守）

- **写 chunk**（B 任务）：事务内 raw INSERT，embedding 序列化 `'[0.1,...]'`、tsv 用 `to_tsvector('simple', $tokens)`；
- **向量检索**：`$queryRaw` + `Prisma.sql`；参数 `'[...]'::vector`；`ORDER BY embedding <=> $1 LIMIT $2`；
- **ef_search 作用域坑**：`SET` 是会话级，连接池下污染别的连接——用**事务内** `SET LOCAL hnsw.ef_search = 100` 或 `SELECT set_config('hnsw.ef_search','100',true)`（实现时二选一验证）；
- **epoch 自增**（C 任务）：`UPDATE conversation_sessions SET epoch=epoch+1, current_participant_id=$1 WHERE id=$2 RETURNING epoch`；
- **任何 raw SQL 涉及租户数据必须带 enterpriseId 过滤**（D 隔离测试覆盖每一条）。

## 9. 后续 schema 变更流程（expand-contract 纪律）

1. 手写新迁移文件 `migrations/<新时间戳>_<名>/migration.sql`（先加可空列/新表=expand）；
2. schema.prisma 同步更新（保持 drift 一致）；
3. `pnpm db:migrate` + `npx prisma generate`；
4. 旧列删除等收缩（contract）单独一个迁移，确认旧版本代码下线后再上。

**生产首次部署**：`prisma migrate deploy`（VPS 上的真 Postgres 会把全部迁移按序采用，与本地跑过同一批文件——双轨一致性）。

## 自测题

1. 本地为什么不能用 `prisma migrate dev`？缺的是什么能力？
2. 双轨一致性靠什么保证？（提示：唯一真相=迁移 SQL 文件）
3. expand-contract 是为了蓝绿的什么问题？
