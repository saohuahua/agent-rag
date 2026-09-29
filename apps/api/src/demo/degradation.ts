import * as path from 'node:path'
import { ingestCorpus } from './corpus-ingest'
import { buildDemoServices } from './bootstrap'

/** 仓库根 */
const REPO_ROOT = path.resolve(process.cwd(), '../..')

/** 断言 */
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`)
    process.exit(1)
  }
  console.log(`  ✓ ${msg}`)
}

/**
 * 降级演练：禁 embedding 路由 → auto 通道纯词法仍出结果
 * 为什么禁路由而非改代码：不改任何模块文件 只切 model_routes.enabled 一行数据
 * auto 语义：向量路失败（路由耗尽）→ allSettled 收口 → 降级纯词法 这是 RAG 模块的灵魂
 * 留证：禁用前命中带 vectorRank 禁用后命中 vectorRank 全空 lexicalRank 有值且命中数 >0
 */
async function main(): Promise<void> {
  console.log('===== 降级演练：禁 embedding 路由 → 纯词法留证 =====')

  const { prisma, redis, gateway, retrieval, chunks } = await buildDemoServices()

  const enterprise = await prisma.enterprise.findUniqueOrThrow({ where: { slug: 'haowu-yanxuan' } })
  const dataset = await prisma.knowledgeDataset.findFirst({ where: { enterpriseId: enterprise.id, name: '规则知识库' } })
  const owner = await prisma.member.findFirst({ where: { enterpriseId: enterprise.id, role: 'OWNER' } })

  // 保证语料就位
  await ingestCorpus({
    prisma, gateway, chunks,
    enterpriseId: enterprise.id, datasetId: dataset!.id, memberId: owner?.id ?? 0,
    corpusDir: path.join(REPO_ROOT, 'corpus'),
  })

  const query = '淘宝网七天无理由退货从哪天开始起算'

  // 基线：auto 双路
  const before = await retrieval.hybridSearch({ enterpriseId: enterprise.id, query, topK: 5, channel: 'auto' })
  const beforeVec = before.filter(h => h.vectorRank !== undefined).length
  const beforeLex = before.filter(h => h.lexicalRank !== undefined).length
  console.log(`\n[基线] auto 命中 ${before.length} 条 含 vectorRank=${beforeVec} 含 lexicalRank=${beforeLex}`)
  assert(before.length > 0, '基线 auto 通道有命中')

  // 禁 embedding 路由（切数据不改代码）
  await prisma.modelRoute.updateMany({ where: { alias: 'embedding' }, data: { enabled: false } })
  console.log('\n[动作] 已禁用 embedding 路由（model_routes.alias=embedding enabled=false）')

  try {
    const after = await retrieval.hybridSearch({ enterpriseId: enterprise.id, query, topK: 5, channel: 'auto' })
    const afterVec = after.filter(h => h.vectorRank !== undefined).length
    const afterLex = after.filter(h => h.lexicalRank !== undefined).length
    console.log(`[降级] auto 命中 ${after.length} 条 含 vectorRank=${afterVec} 含 lexicalRank=${afterLex}`)

    assert(after.length > 0, '禁 embedding 后 auto 仍出结果（纯词法降级成功）')
    assert(afterVec === 0, '降级后命中不含 vectorRank（向量路未参与）')
    assert(afterLex === after.length, '降级后命中全部来自词法路')

    console.log('\n[证据] 降级后首条：')
    const top = after[0]
    console.log(`  docId=${top?.docId} rrfScore=${top?.rrfScore.toFixed(4)} content=${top?.content.slice(0, 60)}...`)
  } finally {
    // 恢复路由 保证后续评测/演示不受影响
    await prisma.modelRoute.updateMany({ where: { alias: 'embedding' }, data: { enabled: true } })
    console.log('\n[恢复] 已重新启用 embedding 路由')
  }

  console.log('===== 降级演练通过 =====')
  await redis.quit()
  await prisma.$disconnect()
}

main().catch(e => {
  console.error(`[degradation] 失败: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
