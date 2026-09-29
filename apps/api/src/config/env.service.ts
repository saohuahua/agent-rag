import { Injectable } from '@nestjs/common'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * .env 加载（自写 替代 @nestjs/config）
 * 为什么不用 @nestjs/config：它当前只承担 dotenv 一职 且其 peer 尚未支持 Nest 12
 * 行为：KEY=VALUE 行解析 不覆盖已存在的环境变量（真实 env 优先）
 */
function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || !m[1]) continue
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2]
    }
  }
}

// dev 从 apps/api 目录起进程 向上两级是根 .env
loadEnvFile(path.resolve(process.cwd(), '../../.env'))
loadEnvFile(path.resolve(process.cwd(), '.env'))

/**
 * 环境变量统一出口（fail-fast）
 * 业务代码禁止直接 process.env 一律从这里取
 * 密钥类（DEEPSEEK/SILICONFLOW）允许为空直到对应任务联调 健康检查不依赖它们
 */
@Injectable()
export class EnvService {
  /** 必填变量缺失即抛 错误消息指明去 .env 填什么 */
  private need(key: string): string {
    const v = process.env[key]
    if (!v) {
      throw new Error(`Missing env ${key} fill it in .env (see .env.example)`)
    }
    return v
  }

  get DATABASE_URL(): string {
    return this.need('DATABASE_URL')
  }

  get REDIS_URL(): string {
    return this.need('REDIS_URL')
  }

  get API_PORT(): number {
    return Number(process.env.API_PORT ?? 3002)
  }

  get DEEPSEEK_API_KEY(): string {
    return process.env.DEEPSEEK_API_KEY ?? ''
  }

  get SILICONFLOW_API_KEY(): string {
    return process.env.SILICONFLOW_API_KEY ?? ''
  }

  /** P4 起使用 现在给开发默认值 */
  get JWT_SECRET(): string {
    return process.env.JWT_SECRET ?? 'dev-insecure-secret'
  }

  /** 网关管理端简单保护 空=不启用 */
  get INTERNAL_API_KEY(): string {
    return process.env.INTERNAL_API_KEY ?? ''
  }
}
