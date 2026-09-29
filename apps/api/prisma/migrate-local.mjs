/**
 * 本地迁移 runner：按序执行 prisma/migrations 各目录下的 migration.sql
 * 为什么不用 prisma migrate dev：PGlite 单库无 shadow database（官方命令跑不了）
 * 为什么自研可行：迁移 SQL 文件是唯一真相 生产用 prisma migrate deploy 跑同一批文件（双轨一致）
 * 行为：簿记表 _local_migrations + 整文件一个事务 + 幂等重跑只应用新文件
 * 用法 node --env-file=../../.env prisma/migrate-local.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(HERE, 'migrations')
const DB_URL = process.env.DATABASE_URL

if (!DB_URL) {
  console.error('缺 DATABASE_URL 用法 node --env-file=../../.env prisma/migrate-local.mjs')
  process.exit(1)
}

/**
 * 列出待执行迁移（目录名排序 一个目录一个迁移）
 * @returns {Array<{name: string, sql: string}>}
 */
function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return []
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(name => fs.existsSync(path.join(MIGRATIONS_DIR, name, 'migration.sql')))
    .sort()
    .map(name => ({
      name,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'),
    }))
}

async function main() {
  const client = new pg.Client({ connectionString: DB_URL })
  await client.connect()

  // 簿记表（与 Prisma 官方 _prisma_migrations 无关 只服务本地）
  await client.query(`
    CREATE TABLE IF NOT EXISTS _local_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  const appliedRows = await client.query('SELECT name FROM _local_migrations')
  const applied = new Set(appliedRows.rows.map(r => r.name))
  const migrations = listMigrations()

  let count = 0
  for (const m of migrations) {
    if (applied.has(m.name)) continue

    // 一个迁移整文件一个事务 失败即回滚退出非零
    try {
      await client.query('BEGIN')
      await client.query(m.sql)
      await client.query('INSERT INTO _local_migrations (name) VALUES ($1)', [m.name])
      await client.query('COMMIT')
      console.log(`[applied] ${m.name}`)
      count += 1
    } catch (e) {
      await client.query('ROLLBACK')
      console.error(`[失败] ${m.name}: ${e.message}`)
      await client.end()
      process.exit(1)
    }
  }

  console.log(`迁移完成 applied=${count} skipped=${migrations.length - count}`)
  await client.end()
}

main().catch(e => {
  console.error(`连接数据库失败: ${e.message}（先跑 pnpm db:up）`)
  process.exit(1)
})
