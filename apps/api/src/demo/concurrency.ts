import { Queue, QueueEvents, Worker } from 'bullmq'
import { buildDemoServices } from './bootstrap'
import { LockBusyError } from '../runtime/runtime.errors'

const QUEUE = 'demo-concurrency'
const SLUG = `conc-${Date.now()}`

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 断言 */
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`)
    process.exit(1)
  }
  console.log(`  ✓ ${msg}`)
}

/**
 * 并发演练：同一会话两 turn 一成一排队 + epoch 日志
 * 为什么用 BullMQ + 真实锁：锁失败抛 LockBusyError → BullMQ 按 backoff 重排 等效排队
 * 正确性由 DB epoch 兜底：两个 turn 最终各得一个递增 epoch 消息落库无覆盖
 */
async function main(): Promise<void> {
  console.log('===== 并发演练：两 turn 一成一排队 =====')

  const { prisma, redis, env, lock } = await buildDemoServices()

  // 自建最小会话数据（唯一 slug 可清理）
  const enterprise = await prisma.enterprise.create({ data: { name: '并发演示企业', slug: SLUG } })
  const session = await prisma.conversationSession.create({ data: { enterpriseId: enterprise.id, status: 'ACTIVE', title: '并发演示' } })
  const sessionId = session.id

  const connection = { url: env.REDIS_URL }
  const queue = new Queue(QUEUE, { connection })
  const queueEvents = new QueueEvents(QUEUE, { connection })

  const worker = new Worker(
    QUEUE,
    async job => {
      const { message } = job.data as { sessionId: number; message: string }

      const token = await lock.tryAcquire(sessionId)
      if (!token) {
        await prisma.executionEvent.create({
          data: { sessionId, type: 'LOCK_WAIT', payloadJson: { message, attempt: job.attemptsMade } },
        })
        console.log(`[并发] turn「${message}」锁被占 LOCK_WAIT 排队（attempt=${job.attemptsMade}）`)
        // 抛错让 BullMQ 按 backoff 重排 等效排队
        throw new LockBusyError(sessionId)
      }

      try {
        const epoch = await lock.bumpEpoch(sessionId)
        console.log(`[并发] turn「${message}」拿到 epoch=${epoch} 开始处理`)

        // 模拟生成耗时 让第二条撞锁
        await sleep(600)

        await lock.guardEpoch(sessionId, epoch, tx =>
          tx.conversationMessage.create({
            data: {
              sessionId, role: 'USER', employeeId: null, epoch,
              partsJson: [{ type: 'text', text: message }], text: message,
            },
          }),
        )
        console.log(`[并发] turn「${message}」完成 epoch=${epoch}`)
        return { epoch }
      } finally {
        await lock.release(sessionId, token)
      }
    },
    { connection, concurrency: 2 },
  )

  await worker.waitUntilReady()

  const opts = { attempts: 6, backoff: { type: 'fixed' as const, delay: 300 } }
  const job1 = await queue.add('turn', { sessionId, message: '第一条消息' }, opts)
  const job2 = await queue.add('turn', { sessionId, message: '第二条消息' }, opts)

  console.log('[并发] 两个 turn 已同时入队 观察串行与排队')

  await Promise.all([
    job1.waitUntilFinished(queueEvents, 30_000),
    job2.waitUntilFinished(queueEvents, 30_000),
  ])

  const msgs = await prisma.conversationMessage.findMany({ where: { sessionId }, orderBy: { epoch: 'asc' }, select: { text: true, epoch: true } })
  console.log('[并发] 消息 epoch 序列:', msgs.map(m => `「${m.text}」=epoch${m.epoch}`).join(' → '))

  const epochs = msgs.map(m => m.epoch)
  assert(epochs.length === 2, `两条消息均落库（实际 ${epochs.length}）`)
  assert(new Set(epochs).size === 2, `epoch 无重复（${epochs.join(',')}）`)
  assert(Math.min(...epochs) === 1 && Math.max(...epochs) === 2, `epoch 序列 1→2（实际 ${epochs.join(',')}）`)

  const lockWaits = await prisma.executionEvent.count({ where: { sessionId, type: 'LOCK_WAIT' } })
  assert(lockWaits >= 1, `LOCK_WAIT 事件 ${lockWaits} 次（一成一排队留证）`)

  // 清理
  await worker.close()
  await queueEvents.close()
  await queue.close()
  await prisma.executionEvent.deleteMany({ where: { sessionId } })
  await prisma.conversationMessage.deleteMany({ where: { sessionId } })
  await prisma.conversationSession.deleteMany({ where: { id: sessionId } })
  await prisma.enterprise.deleteMany({ where: { slug: SLUG } })
  await redis.quit()
  await prisma.$disconnect()

  console.log('===== 并发演练通过 =====')
}

main().catch(e => {
  console.error(`[concurrency] 失败: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
