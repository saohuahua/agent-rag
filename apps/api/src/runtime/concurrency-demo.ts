/**
 * 并发演示脚本：同一会话两个 turn 一成一排队
 * 演示锁 + epoch + BullMQ 重排等效串行 日志含 epoch 变化序列
 * 前置：pnpm db:up && pnpm db:migrate（真实 Redis + PGlite）
 * 运行：pnpm --filter @agent-rag/api exec tsx src/runtime/concurrency-demo.ts
 * 自建自清理唯一标识 可重复运行
 */

import Redis from 'ioredis'
import { Queue, QueueEvents, Worker } from 'bullmq'
import { EnvService } from '../config/env.service'
import { PrismaService } from '../prisma/prisma.service'
import { SessionLockService } from './session-lock.service'
import { LockBusyError } from './runtime.errors'

const env = new EnvService()
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const QUEUE_NAME = 'agent-turn-demo'
const DEMO_SLUG = `demo-${Date.now()}`

/** 自建最小企业数据 返回会话 id */
async function seed(prisma: PrismaService): Promise<number> {
  const enterprise = await prisma.enterprise.create({
    data: { name: '并发演示企业', slug: DEMO_SLUG },
  })

  const pkg = await prisma.subscriptionPackage.create({
    data: { slug: DEMO_SLUG, name: '演示包', description: '并发演示用订阅包' },
  })

  const sub = await prisma.subscription.create({
    data: { enterpriseId: enterprise.id, packageId: pkg.id, lockedPackageVersion: 1 },
  })

  const employee = await prisma.siliconEmployee.create({
    data: {
      enterpriseId: enterprise.id,
      subscriptionId: sub.id,
      templateSlug: 'rule-qa',
      templateVersion: 1,
      displayName: '演示客服',
    },
  })

  const session = await prisma.conversationSession.create({
    data: { enterpriseId: enterprise.id, currentParticipantId: employee.id, title: '并发演示' },
  })

  return session.id
}

/** 按 slug 清理自建数据 */
async function cleanup(prisma: PrismaService): Promise<void> {
  await prisma.conversationSession.deleteMany({ where: { enterprise: { slug: DEMO_SLUG } } })
  await prisma.siliconEmployee.deleteMany({ where: { enterprise: { slug: DEMO_SLUG } } })
  await prisma.subscription.deleteMany({ where: { enterprise: { slug: DEMO_SLUG } } })
  await prisma.subscriptionPackage.deleteMany({ where: { slug: DEMO_SLUG } })
  await prisma.enterprise.deleteMany({ where: { slug: DEMO_SLUG } })
}

async function main(): Promise<void> {
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  const prisma = new PrismaService(env)

  await prisma.$connect()
  const sessionId = await seed(prisma)

  const connection = { url: env.REDIS_URL }
  const queue = new Queue(QUEUE_NAME, { connection })
  const queueEvents = new QueueEvents(QUEUE_NAME, { connection })

  // worker 处理器：真实锁 + 真实 epoch + 假模型（sleep 模拟耗时）
  const lock = new SessionLockService(redis, prisma)
  const worker = new Worker(
    QUEUE_NAME,
    async job => {
      const { message } = job.data as { sessionId: number; message: string }

      const token = await lock.tryAcquire(sessionId)
      if (!token) {
        await prisma.executionEvent.create({
          data: { sessionId, type: 'LOCK_WAIT', payloadJson: { message, attempt: job.attemptsMade } },
        })
        console.log(`[demo] turn「${message}」锁被占 LOCK_WAIT 排队（attempt=${job.attemptsMade}）`)
        // 抛错让 BullMQ 按 backoff 重排 等效排队
        throw new LockBusyError(sessionId)
      }

      try {
        const epoch = await lock.bumpEpoch(sessionId)
        console.log(`[demo] turn「${message}」拿到 epoch=${epoch} 开始处理`)

        // 模拟生成耗时 让第二条撞锁
        await sleep(500)

        await lock.guardEpoch(sessionId, epoch, tx =>
          tx.conversationMessage.create({
            data: {
              sessionId,
              role: 'USER',
              employeeId: null,
              epoch,
              partsJson: [{ type: 'text', text: message }],
              text: message,
            },
          }),
        )

        await prisma.executionEvent.create({
          data: { sessionId, type: 'TURN_END', payloadJson: { message, epoch } },
        })
        console.log(`[demo] turn「${message}」完成 epoch=${epoch}`)
        return { epoch }
      } finally {
        await lock.release(sessionId, token)
      }
    },
    { connection, concurrency: 2 },
  )

  await worker.waitUntilReady()

  const opts = { attempts: 5, backoff: { type: 'fixed' as const, delay: 200 } }
  const job1 = await queue.add('turn', { sessionId, message: '第一条消息' }, opts)
  const job2 = await queue.add('turn', { sessionId, message: '第二条消息' }, opts)

  console.log('[demo] 两个 turn 已同时入队 观察串行与排队')

  await Promise.all([
    job1.waitUntilFinished(queueEvents, 20_000),
    job2.waitUntilFinished(queueEvents, 20_000),
  ])

  const messages = await prisma.conversationMessage.findMany({
    where: { sessionId },
    orderBy: { epoch: 'asc' },
    select: { text: true, epoch: true },
  })
  console.log('[demo] 消息 epoch 序列:', messages.map(m => `「${m.text}」=epoch${m.epoch}`).join(' → '))

  await worker.close()
  await queueEvents.close()
  await queue.close()
  await redis.quit()

  await cleanup(prisma)
  await prisma.$disconnect()
  console.log('[demo] 演示完成 数据已清理')
}

main().catch(async e => {
  console.error(`[demo] 失败: ${e instanceof Error ? e.message : String(e)}`)
  // 尽力清理 避免残留脏数据
  try {
    const prisma = new PrismaService(env)
    await prisma.$connect()
    await cleanup(prisma)
    await prisma.$disconnect()
  } catch {
    // 清理失败忽略
  }
  process.exit(1)
})
