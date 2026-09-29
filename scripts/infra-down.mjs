/**
 * 停止本地基础设施（按 data/*.pid Windows taskkill 树杀）
 * 用法 pnpm db:down
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(ROOT, 'data')

/**
 * 端口是否仍在监听
 * @param {number} port
 */
function portBusy(port) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

/**
 * 按 pid 文件杀进程树（taskkill /T 连子进程一起）
 * @param {string} name 服务名 pg | redis
 */
function killByPidFile(name) {
  const pidFile = path.join(DATA_DIR, `${name}.pid`)
  if (!fs.existsSync(pidFile)) {
    console.log(`[跳过] ${name} 无 pid 文件`)
    return
  }
  const pid = fs.readFileSync(pidFile, 'utf8').trim()
  const r = spawnSync('taskkill', ['/PID', pid, '/F', '/T'], { encoding: 'utf8' })
  if (r.status === 0) {
    console.log(`[完成] ${name} (pid ${pid}) 已停止`)
  } else {
    // 进程可能已自行退出 报错不致命
    console.log(`[提示] ${name} (pid ${pid}) 停止返回非零 可能已退出: ${(r.stderr || '').trim()}`)
  }
  fs.rmSync(pidFile, { force: true })
}

killByPidFile('pg')
killByPidFile('redis')

// 端口残留检查（pid 文件丢失但进程仍在的兜底提示）
setTimeout(async () => {
  for (const p of [5432, 6379]) {
    if (await portBusy(p)) console.log(`[提示] 端口 ${p} 仍在监听 手动处理：netstat -ano | findstr :${p}`)
  }
}, 500)
