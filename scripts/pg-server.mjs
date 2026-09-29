/**
 * PGlite 数据库服务（长驻进程 由 infra-up.mjs 拉起）
 * 职责 内嵌 Postgres + pgvector 扩展 并以标准线协议暴露 127.0.0.1:5432
 * 为什么这么做 本机无 Docker 而 Prisma/pg 只会说线协议 socket 层让它们无感知
 * maxConnections 必须显式放大 默认 1 会拒绝第二个连接（2026-09-29 踩坑实录）
 */

import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(ROOT, 'data')

// 数据目录与日志准备
fs.mkdirSync(DATA_DIR, { recursive: true })
const logStream = fs.createWriteStream(path.join(DATA_DIR, 'pg-server.log'), { flags: 'a' })

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  logStream.write(line + '\n')
}

// 数据落盘 data/pglite 目录（gitignore 可再生）
const db = new PGlite(path.join(DATA_DIR, 'pglite'), { extensions: { vector } })

// 扩展幂等创建（迁移文件里也会再保险一次）
await db.exec('CREATE EXTENSION IF NOT EXISTS vector;')
log('PGlite 就绪 pgvector 扩展已加载')

// 暴露成标准 Postgres 线协议
const server = new PGLiteSocketServer({
  db,
  port: Number(process.env.PG_PORT || 5432),
  host: '127.0.0.1',
  // 必须 ≥ Prisma pg Pool 大小 默认 1 会踢第二个连接
  maxConnections: 32,
})
await server.start()
log(`socket 服务已启动 ${server.getServerConn()} maxConnections=32`)

// 优雅关闭
process.on('SIGINT', async () => {
  log('收到 SIGINT 停止服务')
  await server.stop()
  await db.close()
  process.exit(0)
})
process.on('SIGTERM', async () => {
  await server.stop()
  await db.close()
  process.exit(0)
})
