/**
 * 服务入口 读端口 env MOCK_RPA_PORT 默认 3003
 * 为什么默认 3003: 与 API_PORT 3002 错开 避免并行 dev 端口相撞
 */
import { serve } from '@hono/node-server'
import { buildApp } from './app'
import { seedTickets } from './seed'
import { TicketStore } from './store'

// 端口从 env 读 缺省 3003 非法值回退默认
const rawPort = Number(process.env.MOCK_RPA_PORT ?? 3003)
const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 3003

const store = new TicketStore(seedTickets())
const app = buildApp(store)

console.log(`[mock-rpa] listening on http://127.0.0.1:${port} seed tickets=${store.count()}`)

serve({ fetch: app.fetch, port })
