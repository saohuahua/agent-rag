# 20-01 · 模块规格：Token 网关（M1 · A 任务）

> 五段式：业务问题 → 原理 → 选型对比 → **实现规格（本篇核心）** → 面试深挖区。

## 1. 业务问题

平台所有模型调用若各自直连 provider：密钥散落、无法统一计费、provider 挂了没有降级、成本无人知晓。网关=「算力统一计量」的落点：一个 OpenAI 兼容入口，路由到多 provider 多模型，失败自动换下一跳，每次调用记账。

## 2. 原理

- **OpenAI-Compatible 协议**：请求 `{model, messages, stream?, stream_options?}`；响应非流式 `{id, object:"chat.completion", choices:[{message:{role,content}}], usage:{prompt_tokens, completion_tokens}}`；流式为 SSE，`data: {"choices":[{"delta":{"content"}}]}` 增量块 + 末块 usage + `data: [DONE]`。DeepSeek/SiliconFlow 都遵循——所以我们的网关对外也长这样，任何 OpenAI 客户端可直接调用。
- **降级链**：同一 alias 多条 ModelRoute 按 priority 升序；上游 5xx/超时/网络错→换下一跳；4xx（参数/鉴权）不换（换了也一样）。
- **计量**：AI SDK provider 开 `includeUsage: true`，`streamText` 的 `onFinish` 拿 `usage`；价格表在 ModelRoute 上（元/百万 token），成本 `Decimal` 精算。

## 3. 选型对比

| 方案 | 取舍 |
|---|---|
| **自写薄网关（选）** | 几百行；计量/降级/预算全掌控；教学文档可讲每个细节 |
| LiteLLM | Python 常驻网关 与本项目栈不合；黑盒化最有讲头的部分 |
| one-api/new-api | 成品网关 但接入它们=「装了个软件」不是「实现了能力」 |
| sub2api | 订阅转 API（Claude Pro 等 OAuth→API 分发）有 ToS 风险；其真正有价值的工程是统一计量/计费——这正是我们自写的部分 |

## 4. 实现规格

### 4.1 文件清单（A 任务独占 `apps/api/src/gateway/`）

```
gateway/
├─ gateway.module.ts        // @Global() 导出 GatewayService/UsageMeter
├─ gateway.service.ts       // 契约实现：chat/chatStream/embedMany/embeddingHealthy
├─ provider-registry.ts     // DB 的 ModelProvider 行 → AI SDK provider 实例（缓存）
├─ model-router.ts          // alias → 降级链解析 + 逐跳尝试
├─ usage-meter.service.ts   // UsageMeter 实现（写 usage_records Decimal）
├─ health-tracker.ts        // 每条 route 的滑动失败计数 + 60s 冷却
├─ budget-guard.ts          // 企业月度预算软熔断
├─ gateway.controller.ts    // /v1/chat/completions /v1/embeddings /healthz
└─ admin-gateway.controller.ts // /admin/providers|routes CRUD /admin/usage/summary
```

### 4.2 HTTP API 契约

| 端点 | 方法 | 说明 |
|---|---|---|
| `/v1/chat/completions` | POST | OpenAI 形状。body.model = **route alias**（如 `chat`）；支持 `stream:true`（SSE OpenAI 块格式）；`stream_options.include_usage` 时末块带 usage |
| `/v1/embeddings` | POST | `{input: string[], model: 'embedding'}`；返回 `{data:[{embedding:[...]}], usage}`；**首调断言 1024 维**（不符抛错记 health） |
| `/healthz` | GET | `{db:'ok', redis:'ok'}`（任务 0 已建，A 增补 gateway 信息） |
| `/admin/usage/summary` | GET | 按企业/别名/日汇总 `{groups:[{enterpriseId, routeAlias, calls, inputTokens, outputTokens, costCny}]}` |

**网关鉴权**：P0 用 `x-api-key: $INTERNAL_API_KEY`（env，非空才启用）保护 /admin/*；/v1/* 暂开放（D 任务接入成员 JWT 后收紧到登录用户）。

### 4.3 路由与降级算法

```typescript
// model-router.ts 伪代码级规格
async resolve(alias: string): Promise<RouteHop[]> {
  // routes = SELECT ... FROM model_routes JOIN model_providers
  //   WHERE alias=$alias AND enabled AND provider.enabled ORDER BY priority ASC
  // 过滤 health-tracker 处于冷却期的 hop（全冷却则返回全部 允许重试）
}

async chatWithFailover(opts): Promise<GatewayStream> {
  // for hop of hops:
  //   try { 调 provider 实例 streamText 记录 usage 并 meter.record 成功 return }
  //   catch (e) {
  //     isFailoverable(e)（5xx/超时/网络） → health.fail(hop) continue
  //     4xx → 直接 throw（换路也一样错）
  //   }
  // throw new RouteExhaustedError(`alias=${alias} 全部路由失败`)（英文错误码 RouteExhausted）
}
```

- 每跳**不重试**（重试语义留给调用方/BullMQ attempts；避免放大故障）——此决策写进代码注释。
- `embeddingHealthy()` = embedding alias 的全部 hop 是否都在冷却。

### 4.4 计量实现要点

- `includeUsage: true` 必开（openai-compatible provider 选项）；
- `onFinish({ usage })` → `costCny = (in*priceIn + out*priceOut) / 1_000_000`，用 `new Prisma.Decimal(...)` 计算后 `.toNumber()` 只在序列化时；
- 失败调用也记账（success=false, errorCode）——失败成本也是成本；
- BudgetGuard：写账前查该企业当月累计，超 `enterprises.monthlyBudgetCny` 则抛 `BudgetExceededError`（HTTP 429）。

### 4.5 响应格式化（OpenAI 兼容层）

`chatStream` 的 `textStream` 重排为 OpenAI chunk：每 delta 一条 `data: {json}\n\n`；结束时若请求带 `include_usage` 补 usage 块；最后 `data: [DONE]\n\n`。非流式聚合成 completion 对象。id 用 `chatcmpl-${crypto.randomUUID()}`。

### 4.6 测试清单（vitest，A 任务自带）

- 路由解析：多 hop 排序、禁用过滤、冷却过滤
- 降级：mock 第一跳 5xx → 第二跳成功且记账两条（一条 fail 一条 success）
- 4xx 不换路直接抛
- 计量：价格换算正确（1M in + 1M out → 5.0 元 for flash 价格）；Decimal 精度
- budget 熔断触发 429
- 健康冷却：连续 3 失败 → 60s 冷却 → embeddingHealthy()=false

### 4.7 验收

- `curl -N -X POST :3002/v1/chat/completions -d '{"model":"chat","messages":[{"role":"user","content":"你好"}],"stream":true}'` 流式输出中文回复 + usage 块 + [DONE]
- psql 查 usage_records 出现真实 token 数与成本
- 改坏 deepseek baseUrl → 自动切 siliconflow hop 成功（日志可见 RouteExhausted 前的 failover 记录）

## 5. 面试深挖区

- 「为什么不用 sub2api/one-api？」→ 见 §3；补一句：sub2api 解决的是「订阅额度分发拼车」的成本问题，我们用官方按量 API+统一计量达到同样的工程目标，没有 ToS 风险
- 「流式怎么计 token？」→ includeUsage + onFinish（usage 在流结束时才返回）
- 「为什么每跳不重试？」→ 避免故障放大；调用侧已有 BullMQ attempts 语义；降级链本身就是「换资源重试」
- 「成本精度？」→ Decimal(10,6)，JS number 直算会有浮点累计误差
- 「模型名退役怎么办？」→ ModelRoute 是 DB 数据，改一行配置即切换，代码无感（deepseek-chat→deepseek-flash 真实发生过）
