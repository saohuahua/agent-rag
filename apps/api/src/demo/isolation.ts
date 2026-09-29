import { buildDemoServices } from './bootstrap'
import { DocSourceType, DocStatus } from '../generated/prisma/enums'
import { tokenize } from '../rag/tokenizer'

/** 断言 */
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`)
    process.exit(1)
  }
  console.log(`  ✓ ${msg}`)
}

/** 合成 1024 维零向量 词法检索不依赖向量 只为满足 vector 列维度约束 */
function zeroEmbedding(): number[] {
  return Array(1024).fill(0)
}

/** 隔离夹具唯一 slug */
const SLUG_A = `iso-a-${Date.now()}`
const SLUG_B = `iso-b-${Date.now()}`

/**
 * 隔离复验：raw SQL 口（chunk.repository）租户隔离
 * 为什么只验词法路：向量/词法两路 raw SQL 都带同一句 JOIN knowledge_docs 过滤
 * 词法路不烧 embedding 最省事 验证的是同一处过滤子句
 * 为什么这是 raw SQL 口：chunk 无 enterpriseId 列 必须 JOIN doc 过滤 这是唯一跨租户风险点
 */
async function main(): Promise<void> {
  console.log('===== 隔离复验：raw SQL 口租户隔离 =====')

  const { prisma, redis, chunks } = await buildDemoServices()

  // 建两个隔离企业各带一 doc 一 chunk 内容关键词互不相同
  const entA = await prisma.enterprise.create({ data: { name: '隔离A企业', slug: SLUG_A } })
  const entB = await prisma.enterprise.create({ data: { name: '隔离B企业', slug: SLUG_B } })

  const dsA = await prisma.knowledgeDataset.create({ data: { enterpriseId: entA.id, name: 'A库' } })
  const dsB = await prisma.knowledgeDataset.create({ data: { enterpriseId: entB.id, name: 'B库' } })

  const docA = await prisma.knowledgeDoc.create({
    data: {
      datasetId: dsA.id, enterpriseId: entA.id, title: 'A文档', sourceType: DocSourceType.MANUAL,
      storageKey: 'iso/a.md', mimeType: 'text/plain', sizeBytes: 10,
      checksum: `iso-a-${Date.now()}`, status: DocStatus.UPLOADED, uploadedBy: 0,
    },
  })
  const docB = await prisma.knowledgeDoc.create({
    data: {
      datasetId: dsB.id, enterpriseId: entB.id, title: 'B文档', sourceType: DocSourceType.MANUAL,
      storageKey: 'iso/b.md', mimeType: 'text/plain', sizeBytes: 10,
      checksum: `iso-b-${Date.now()}`, status: DocStatus.UPLOADED, uploadedBy: 0,
    },
  })

  // A 放「七天无理由退货」 B 放「手机三包维修」 关键词互斥
  await chunks.ingest(docA.id, [{
    seq: 0, content: '七天无理由退货政策 消费者签收后七天内可无理由退货', page: null, headingPath: 'A',
    tokenCount: 0, embedding: zeroEmbedding(), tokens: tokenize('七天无理由退货政策 消费者签收后七天内可无理由退货'),
  }])
  await chunks.ingest(docB.id, [{
    seq: 0, content: '手机三包政策 主机三包有效期内免费维修', page: null, headingPath: 'B',
    tokenCount: 0, embedding: zeroEmbedding(), tokens: tokenize('手机三包政策 主机三包有效期内免费维修'),
  }])

  console.log(`\n[造数] 企业A id=${entA.id} doc=${docA.id} 企业B id=${entB.id} doc=${docB.id}`)

  // A 检索「七天 退货」应命中自己的 chunk 且不含 B
  const hitsA = await chunks.lexicalSearch(entA.id, tokenize('七天 退货'))
  const idsA = hitsA.map(h => h.docId)
  assert(hitsA.length > 0, `企业A 检索命中 ${hitsA.length} 条`)
  assert(idsA.includes(docA.id) && !idsA.includes(docB.id), `企业A 只看到自己的 doc=${idsA.join(',')} 不含 B`)

  // B 检索同样关键词应 0 命中（A 的 chunk 被 JOIN 过滤掉）
  const hitsB = await chunks.lexicalSearch(entB.id, tokenize('七天 退货'))
  assert(hitsB.length === 0, `企业B 查「七天 退货」0 命中（A 数据不可见）`)

  // B 检索自己的关键词应命中
  const hitsB2 = await chunks.lexicalSearch(entB.id, tokenize('三包 维修'))
  assert(hitsB2.some(h => h.docId === docB.id), '企业B 检索自己关键词命中')

  // 清理
  await prisma.knowledgeDoc.deleteMany({ where: { id: { in: [docA.id, docB.id] } } })
  await prisma.knowledgeDataset.deleteMany({ where: { id: { in: [dsA.id, dsB.id] } } })
  await prisma.enterprise.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } })

  console.log('\n===== 隔离复验通过 =====')
  await redis.quit()
  await prisma.$disconnect()
}

main().catch(e => {
  console.error(`[isolation] 失败: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
