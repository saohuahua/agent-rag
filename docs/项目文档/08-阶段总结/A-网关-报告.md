# 任务 A · M1 Token 网关 报告（2026-09-29）

> 工作目录已从 `agent-rag` 迁移到 `D:\project\agent-A`（用户指示），迁移方式：排除 node_modules/.git/data/构建产物后整体复制 + `pnpm install` 重装 + `prisma generate` + shared build + db:up/migrate/seed 复核。

## 1. 交付物清单（对照验收逐条）

| 验收项 | 结果 | 证据 |
|---|---|---|
| ProviderRegistry 读 model_providers/model_routes 按 alias 分组 priority 升序组成降级链 | ✅ | `model-router.ts resolveHops` orderBy priority asc + include provider |
| ModelRouter 按降级链尝试 全部失败抛 RouteExhaustedError | ✅ | 单测 + 无 key 冒烟返回 502 `RouteExhausted` |
| chat / chatStream / embedMany 用 openai-compatible provider | ✅ | `provider-registry.ts createOpenAICompatible`（chatModel/textEmbeddingModel） |
| UsageMeter onFinish 记账 costCny 用 Prisma.Decimal 写入（禁 number 直写） | ✅ | `usage-meter.service.ts` `new Prisma.Decimal(costCny)`；单测断言 `instanceof Prisma.Decimal` |
| embeddingHealthy 连续失败进冷却返回 false | ✅ | 单测：3 次失败 → `isEmbeddingHealthy()===false` |
| 暴露 /v1/chat/completions（流式+非流式）与 /v1/embeddings | ✅ | `gateway.controller.ts`；冒烟日志确认路由映射 |
| curl 报出精确费用（模型/token/¥）+ usage_records 落一行 | ✅ | 非流式 curl：38 in / 3311 out / cost_cny=0.013282，验证 (38×1+3311×4)/1e6=0.013282 分位精确；usage_records 落行 |
| 降级链实测：p1 key 改错自动落 p2 | ✅ | 环境变量覆盖 DEEPSEEK_API_KEY=错值 → 请求命中 siliconflow（cost=0.0000812 符合 p2 价 0/0.2），账本两条：deepseek HTTP_401 fail + siliconflow success |
| pnpm typecheck + pnpm test（gateway 范围）全绿 | ✅ | 23/23（5 文件） typecheck 0 错误 |
| admin-gateway.controller（CRUD + /admin/usage/summary） | ✅ | 规格 §4.1/§4.2 附加件 已实现并映射 |

## 2. 与文档计划的偏差（已写注释 备案）

1. **401 列为可降级**：规格 §4.3 原文「4xx（参数/鉴权）不换」，但验收要求「把 p1 路由 key 改错 → 请求自动落 p2」。key 改错即上游返回 401，若按原文 401 不换路则该验收无法达成。故把 401/429 单独列为可降级（换供应商=换密钥，可解），其余 4xx（参数错/模型不存在）仍不换。已在 `isFailoverable` 注释写明原因。
2. **provider-registry 密钥改经 EnvService**：原桩直接 `process.env[row.apiKeyEnv]` 并注释「合理例外」，与硬约束「密钥只经 EnvService 读」冲突。已改为 EnvService 按变量名映射 getter。代价：新增供应商需在 EnvService（共享文件，任务 0 持有）补 getter 并在此映射，已在注释备案。
3. **测试落点**：测试放 `apps/api/tests/gateway/`（vitest include 只扫 `tests/**`），非 `src/gateway/` 内。未改 `vitest.config.ts` 与 `tests/smoke.spec.ts`。

## 3. 踩坑实录（面试可讲）

| # | 坑 | 解法 |
|---|---|---|
| 1 | AI SDK `streamText` 的 `textStream` 内部用 `ReadableStream.tee()` 分流，只读 textStream 不访问 `result.usage` 会让另一分支背压，流卡在首分片之后 | 必须访问 `result.usage`（触发 SDK 排空另一分支），同时以它作为记账时机。单测用假 textStream 暴露不了，读 SDK 源码才发现 |
| 2 | `StreamTextResult.usage` 类型是 `PromiseLike` 非 `Promise`，没有 `.catch` | `Promise.resolve(result.usage)` 包裹后再链式 `.then/.catch` |
| 3 | `streamText` 是懒请求：调用它不发起网络，首分片 `next()` 才发起真实 HTTP | 降级必须在读首分片时做（eager prime），401/网络错在返回前暴露才能换下一跳 |
| 4 | robocopy 在 Git Bash 下 `/E` 等旗标被 MSYS 路径转换破坏 | 改用 `tar --exclude` 迁移 |

## 4. 真实数字

- 迁移：复制（排除 node_modules/.git/data/dist/generated）+ `pnpm install` 5m42s（全部走 pnpm 本地 store）+ `prisma generate` 1.07s
- 测试：23/23，5 个文件，运行 1.4s
- 冒烟（无 key）：`/v1/chat/completions` 与 `/v1/embeddings` 均优雅返回 502 `RouteExhausted`，日志确认 provider 跳过逻辑正常
- 账本 seed：providers=2 routes=4 skills=7 templates=6（复用已运行 PGlite）

## 5. 阻塞与下一步

**阻塞已解除**：key 有效（DeepSeek /user/balance 200 余额 ¥1.93，SiliconFlow /v1/models 200），真实调用验收全部通过。

早前的 401 是 `.env` 里还是旧值（`k-` 前缀）导致，用户换新 key 后正常。

### 验收命令（已全部验证通过）

```bash
cd D:\project\agent-A
pnpm --filter @agent-rag/api dev      # 监听 3002

# ① 非流式：应返回 usage.cost_cny
curl -s -X POST http://127.0.0.1:3002/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"chat","messages":[{"role":"user","content":"你好"}]}'

# ② 流式：SSE 增量 + usage 块 + [DONE]
curl -N -X POST http://127.0.0.1:3002/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"chat","messages":[{"role":"user","content":"你好"}],"stream":true,"stream_options":{"include_usage":true}}'

# ③ 查账
curl -s http://127.0.0.1:3002/admin/usage/summary

# ④ 降级实测：临时环境变量覆盖错 key 重启
DEEPSEEK_API_KEY=sk-invalid node apps/api/dist/main.js   # 请求自动落 siliconflow

# ⑤ 全绿复核
pnpm --filter @agent-rag/api typecheck && pnpm --filter @agent-rag/api test
```

## 6. 契约变更提案

无（契约签名 §2/§3 完全保持不变）。仅 401 降级语义是对规格 §4.3 行为层面的偏差，已在上文备案，如用户认为应严格遵循「4xx 一律不换」，需同时调整验收措辞（key 改错→baseUrl 改错）。
