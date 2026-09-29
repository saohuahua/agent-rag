/**
 * 本地基础设施一键拉起：PGlite socket(5432) + Windows 原生 Redis(6379)
 * 幂等 端口被占时跳过并提示 两个进程的 pid 写 data/*.pid 供 infra-down 停止
 * 用法 pnpm db:up
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(ROOT, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const PG_PORT = Number(process.env.PG_PORT || 5432)
const REDIS_PORT = 6379

/**
 * 端口是否已被监听（连接成功即在运行）
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function portBusy(port) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

/** 等端口就绪 超时返回 false */
async function waitPort(port, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await portBusy(port)) return true
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

/**
 * 派生后台进程（Windows detached）日志落 data/
 * @returns {number} pid
 */
function spawnDetached(cmd, args, logFile) {
  const out = fs.openSync(path.join(DATA_DIR, logFile), 'a')
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', out, out] })
  child.unref()
  fs.closeSync(out)
  return child.pid
}

function writePid(name, pid) {
  fs.writeFileSync(path.join(DATA_DIR, `${name}.pid`), String(pid))
}

async function main() {
  // ---- PGlite socket 服务 ----
  if (await portBusy(PG_PORT)) {
    console.log(`[跳过] :${PG_PORT} 已有服务在监听（PGlite 已在运行）`)
  } else {
    const node = process.execPath
    const pid = spawnDetached(node, [path.join(ROOT, 'scripts', 'pg-server.mjs')], 'pg-server-stdout.log')
    writePid('pg', pid)
    const ok = await waitPort(PG_PORT, 15000)
    console.log(ok ? `[完成] PGlite socket 服务已起 127.0.0.1:${PG_PORT} (pid ${pid})` : '[失败] PGlite 15s 未就绪 查看 data/pg-server-stdout.log')
    if (!ok) process.exitCode = 1
  }

  // ---- Windows 原生 Redis ----
  if (await portBusy(REDIS_PORT)) {
    console.log(`[跳过] :${REDIS_PORT} 已有服务在监听（Redis 已在运行）`)
  } else {
    // PATH 里的 redis-server 本机为 winget 安装的 redis-windows 8.10
    try {
      const pid = spawnDetached('redis-server', ['--port', String(REDIS_PORT)], 'redis.log')
      writePid('redis', pid)
      const ok = await waitPort(REDIS_PORT, 8000)
      console.log(ok ? `[完成] Redis 已起 127.0.0.1:${REDIS_PORT} (pid ${pid})` : '[失败] Redis 8s 未就绪（确认 PATH 里有 redis-server：winget install taizod1024.redis-windows-fork）')
      if (!ok) process.exitCode = 1
    } catch (e) {
      console.error(`[失败] 无法启动 redis-server: ${e.message}`)
      console.error('新机器先安装：winget install taizod1024.redis-windows-fork')
      process.exitCode = 1
    }
  }
}

main()
