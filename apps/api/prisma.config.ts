import { defineConfig } from 'prisma/config'

// Prisma 7 配置：schema 路径 / 迁移路径 / seed 命令 / 连接串来源
// 注意 datasource 的 url 只服务 CLI（migrate diff 等）运行时走 PrismaService 的 driver adapter
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node --env-file=../../.env --import tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
})
