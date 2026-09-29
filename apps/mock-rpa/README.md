# mock-rpa 电商售后工单系统

任务 G 的交付物。这是一个用 Hono + @hono/node-server + zod 实现的 mock 电商售后工单系统，
作为「企业 AI 数字员工平台」里 RPA 技能（任务 H 的 HTTP_RPA 技能）的操作对象。

## 1 定位

- 模拟电商售后工单的查询、列表、批量操作、状态流转。
- 数据存内存 Map，重启自动回到种子数据，保证 RPA 技能调试可复现。
- 全部接口入参用 zod 校验，非法入参返回明确 4xx，方便 RPA 按错误码做重试或降级。

## 2 启动

```bash
# 在仓库根目录
pnpm --filter mock-rpa dev

# 或在 apps/mock-rpa 目录内
pnpm dev
```

- 端口：读环境变量 `MOCK_RPA_PORT`，缺省 `3003`（与 API 端口 3002 错开，避免并行 dev 相撞）。
- 启动后打印：`[mock-rpa] listening on http://127.0.0.1:3003 seed tickets=24`

## 3 状态机

```
OPEN ──> PROCESSING ──> RESOLVED
                └────> REJECTED
```

| 当前态 | 可达目标态 |
|---|---|
| OPEN | PROCESSING |
| PROCESSING | RESOLVED / REJECTED |
| RESOLVED | 无（终态） |
| REJECTED | 无（终态） |

非法流转返回 `409 INVALID_TRANSITION`。

## 4 数据模型 Ticket

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 工单号，形如 `T0001`，正则 `T\d{4}` |
| shopId | string | 店铺 id，形如 `S001` |
| shopName | string | 店铺名 |
| orderNo | string | 关联订单号 |
| productName | string | 商品名（种子埋了广告法违禁词，供后续风险扫描演示） |
| buyerNick | string | 买家昵称 |
| issueType | enum | 售后类型 `REFUND` 退款 / `RETURN` 退货 / `EXCHANGE` 换货 / `COMPLAINT` 投诉 / `CONSULT` 咨询 |
| status | enum | 状态 `OPEN` / `PROCESSING` / `RESOLVED` / `REJECTED` |
| priority | enum | 优先级 `LOW` / `NORMAL` / `HIGH` / `URGENT` |
| tags | string[] | 人工或 RPA 打的标记 |
| refundAmount | number\|null | 退款金额，单位分，非退款单为 null |
| refunded | boolean | 是否已退款 |
| description | string | 问题描述 |
| createdAt | string | 创建时间 ISO 8601 |
| updatedAt | string | 最后更新时间 ISO 8601 |

## 5 接口清单

所有响应均为 `application/json`。错误统一结构见 §6。

### 5.1 GET /healthz

健康检查。

出参：`{ ok: true, service: "mock-rpa", ticketCount: 24 }`

### 5.2 GET /tickets/:id —— 工单查询（按 id）

入参：路径参数 `id`，格式 `T\d{4}`。

出参（200）：单个 Ticket 对象。

错误：`400`（id 格式非法）、`404 TICKET_NOT_FOUND`（不存在）。

```
curl http://127.0.0.1:3003/tickets/T0001
```

### 5.3 GET /tickets —— 工单列表（分页）+ 按店铺 / 按状态查询

入参（query）：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| page | number | 否 | 1 | 页码，从 1 开始，正整数 |
| pageSize | number | 否 | 20 | 每页条数，1~100 |
| shopId | string | 否 | - | 按店铺过滤，如 `S001` |
| status | enum | 否 | - | 按状态过滤，`OPEN`/`PROCESSING`/`RESOLVED`/`REJECTED` |

出参（200）：

```json
{
  "items": [ /* Ticket 数组，按 id 升序 */ ],
  "total": 24,
  "page": 1,
  "pageSize": 20,
  "totalPages": 2
}
```

错误：`400`（page/pageSize 非正整数、status 非枚举）。

```
curl "http://127.0.0.1:3003/tickets?page=1&pageSize=3"
curl "http://127.0.0.1:3003/tickets?shopId=S001"
curl "http://127.0.0.1:3003/tickets?status=OPEN"
```

### 5.4 POST /tickets/:id/transition —— 状态流转

入参：路径参数 `id`；JSON body `{ "to": "PROCESSING" }`，`to` 为目标状态枚举。

出参（200）：流转后的 Ticket 对象。

错误：`400`（id 或 to 非法）、`404`（不存在）、`409 INVALID_TRANSITION`（非法流转）。

```
curl -X POST http://127.0.0.1:3003/tickets/T0002/transition \
  -H 'content-type: application/json' -d '{"to":"PROCESSING"}'
```

### 5.5 POST /tickets/batch/tag —— 批量标记

入参（JSON body）：

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| ids | string[] | 是 | - | 工单号数组，非空，每项格式 `T\d{4}` |
| tags | string[] | 是 | - | 标记数组，非空，每项非空字符串 |
| mode | enum | 否 | `add` | `add` 添加标记 / `remove` 移除标记 |

出参（200）：

```json
{ "ok": true, "updated": ["T0003"], "missing": [], "rejected": [] }
```

- `updated`：处理成功的工单号。
- `missing`：不存在的工单号。
- `rejected`：被拒的工单号与原因（批量标记无拒绝场景，恒为空，保留字段对齐批量退款结构）。

错误：`400`（ids/tags 为空、id 格式非法）。

```
curl -X POST http://127.0.0.1:3003/tickets/batch/tag \
  -H 'content-type: application/json' \
  -d '{"ids":["T0003","T0006"],"tags":["需人工复核"],"mode":"add"}'
```

### 5.6 POST /tickets/batch/refund —— 批量退款

入参（JSON body）：

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| ids | string[] | 是 | - | 工单号数组，非空，每项格式 `T\d{4}` |
| amount | number | 否 | - | 退款金额，单位分，非负整数；缺省用工单已有金额否则 0 |

出参（200）：

```json
{ "ok": true, "updated": ["T0001"], "missing": [], "rejected": [{"id":"T0011","reason":"..."}] }
```

- 退款成功：`refunded=true`、写入 `refundAmount`、状态自动置 `RESOLVED`。
- 只允许 `PROCESSING` 状态退款，其余状态进 `rejected`（退款必须先进入处理中）。

错误：`400`（ids 为空、id 格式非法、amount 非非负整数）。

```
curl -X POST http://127.0.0.1:3003/tickets/batch/refund \
  -H 'content-type: application/json' \
  -d '{"ids":["T0001","T0003"],"amount":9900}'
```

## 6 错误码约定

统一响应体：

```json
{ "error": "CODE", "message": "english message", "issues": [ {"path":"to","message":"..."} ] }
```

| error | HTTP | 含义 |
|---|---|---|
| VALIDATION_ERROR | 400 | 入参 zod 校验失败，`issues` 列出每条问题 |
| INVALID_JSON | 400 | 请求体不是合法 JSON |
| TICKET_NOT_FOUND | 404 | 工单不存在 |
| INVALID_TRANSITION | 409 | 状态机不允许的流转 |
| NOT_FOUND | 404 | 路由不存在 |
| INTERNAL_ERROR | 500 | 未预期异常 |

## 7 种子数据

24 条工单，覆盖 5 店铺（S001~S005）、5 种售后类型、4 种状态。时间戳用固定基准生成，
重启后数据完全一致。商品名埋了广告法违禁词（全网最低、100%有效、国家级、第一）。

## 8 验收自测（已通过）

- `pnpm --filter mock-rpa dev` 启动，监听 3003，种子 24 条。
- 核心接口：查询（`GET /tickets/T0001`）、列表（`GET /tickets?page=1&pageSize=3`）、状态流转（`POST /tickets/T0002/transition`）均 200。
- 非法入参 4xx：非法 id 400、page 非数字 400、status 非枚举 400、非法流转 409、空 ids 400、非法 JSON 400、未匹配路由 404。

## 9 完成报告

- 交付物：`apps/mock-rpa/`（Hono 应用 src/ + README）。
- 接口：查询（id/店铺/状态）、列表分页、批量标记、批量退款、状态流转、healthz，全部 zod 校验入参。
- 种子：24 条内存工单，重启回种子。
- 边界遵守：只动 `apps/mock-rpa/`，未新增依赖（复用 hono/@hono/node-server/zod 白名单），未 commit/push。
- 待用户裁决：根 `.env` 里 `MOCK_RPA_PORT=3003` 与本任务提示的 3002 不一致，已按 3003（与 .env 一致）实现，代码读 env 缺省 3003。
