# 向量检索与 HNSW 索引

向量路解决「语义召回」：换一种说法也能找到。它的原理是把文字映射成高维向量，语义相近的文本在向量空间里距离近，检索变成「找距离最近的若干向量」。本文讲 embedding 是什么、为什么选 bge-m3、HNSW 怎么在召回率和延迟之间权衡，以及维度这个常被忽略的坑。

> 阅读起点：读过 [00-RAG从零到双路召回](00-RAG从零到双路召回.md) 的「五 向量路」。源码根为 `apps/api/src/`。

## embedding 是什么

embedding 模型把一段文本编码成固定长度的数字向量。它不是简单的「字符串转数字」，而是让语义相近的文本得到相近的向量：

```text
「七天无理由退货」      → [0.12, -0.83, 0.41, ...]  1024 维
「七天无理由退换货」    → [0.11, -0.81, 0.40, ...]  向量很接近
「手机三包维修」        → [0.87, 0.21, -0.33, ...]  向量差很远
```

「语义相近」由模型的训练目标保证：训练时要求同义句向量近、异义句向量远。于是「买错了能退吗」和「七天无理由退货」虽然字面完全不同，向量距离却很近——这就是向量路能补上词法路「改写问法召回不到」的原因。

## 为什么选 bge-m3

| 考量 | bge-m3 的情况 |
| --- | --- |
| 中文能力 | 中文语料训练充分，电商规则/法规这类中文文本表现好 |
| 维度 | 1024 维，召回精度与存储成本的平衡点 |
| 成本 | 走 SiliconFlow，当前免费（0 元/百万 token） |
| 接入 | OpenAI 兼容接口，复用网关的 `textEmbeddingModel` |

维度是固定契约：入库时所有 chunk 向量、查询向量都是 1024 维，才能互相算距离。网关在首次调用时断言维度，不符即报 `EmbeddingDimensionError`，把「配错模型」这类问题挡在入库前。

真实计量（一次全量评测）：494 次 embedding 调用、12.18 万 token、成本 0 元。免费模型让「语料入库 + 查询」这条路可以反复跑而不烧钱。

## 余弦距离与 `<=>` 运算符

向量算距离有三种常见方式：欧氏距离、内积、余弦。语义检索用**余弦距离**——它衡量方向夹角而不是绝对长度，对「长文本和短文本向量长度不同」更鲁棒：

```text
余弦距离越小 → 夹角越小 → 语义越近
```

Postgres 的 pgvector 扩展用 `<=>` 表示余弦距离：

```sql
SELECT id FROM knowledge_chunks
ORDER BY embedding <=> '[0.12,-0.83,...]'::vector
LIMIT 50
```

`::vector` 把字符串转成向量类型，参数化传参防注入。查询向量序列化成 `[0.12,-0.83,...]` 字符串再转换，这是向量列无法走 ORM、必须 raw SQL 的原因之一。

## HNSW 索引：近似的代价

全量数据里逐条算余弦距离是精确的，但太慢。HNSW（Hierarchical Navigable Small World）是近似最近邻索引，用一个多层图结构组织向量：上层稀疏跳得快、下层密集搜得准，查询时从上层往下贪心搜索，很快逼近最近邻，代价是「近似」——可能漏掉极少数真正最近的向量。

和另一常见选择 IVFFlat 对比：

| 方案 | 原理 | 特点 |
| --- | --- | --- |
| IVFFlat | 先聚类分桶，查询只搜邻近桶 | 建索引快，召回受分桶边界影响 |
| HNSW | 多层图 + 贪心搜索 | 查询快、召回高，建索引慢、内存占用高 |

本项目数据量小（315 chunks）、对召回率要求高，选 HNSW 合适。建索引用余弦距离算子：

```sql
CREATE INDEX ... ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
```

## ef_search：召回与延迟的旋钮

HNSW 的查询质量由 `ef_search` 控制：它决定搜索时维护多大的候选集。值越大召回越全、越慢；越小越快、越可能漏。本项目设 100：

```sql
SET LOCAL hnsw.ef_search = 100;
```

关键在 `SET LOCAL` 而不是 `SET`。`ef_search` 是会话级参数，Prisma 连接池复用一个会话，直接 `SET` 会污染别的连接（别的请求也被改成 100 或残留成其它值）。`SET LOCAL` 只在事务内生效、事务结束自动回滚，所以把它包在事务里执行：

```ts
return this.prisma.$transaction(async tx => {
  await tx.$executeRaw(Prisma.sql`SET LOCAL hnsw.ef_search = 100`)
  return tx.$queryRaw(Prisma.sql`SELECT ... ORDER BY embedding <=> ...`)
})
```

## 维度是必须先解决的坑

HNSW 建索引要求向量列声明维度，未声明维度的 `vector` 列无法建 HNSW。Prisma 的 `Unsupported("vector")` 表达不了维度，所以迁移里手写补了一句：

```sql
ALTER TABLE "knowledge_chunks" ALTER COLUMN "embedding" TYPE vector(1024);
```

这一步是任务 0 的踩坑：先按 `vector` 建列，HNSW 建索引报「column does not have dimensions」，回填 `vector(1024)` 后才成功。它说明向量列的维度不是运行时约束，而是 DDL 层就要锁死的契约——所有写入和查询的向量必须同维度，否则距离计算无意义。

## 一条查询在向量路的完整路径

```text
「七天无理由退货」
  → bge-m3 得到 1024 维向量
  → 事务内 SET LOCAL hnsw.ef_search = 100
  → ORDER BY embedding <=> '[...]'::vector
  → 距离升序取前 50 → 向量名次
```

向量路强在「语义」：问「买错了能退吗」能召回「七天无理由退货」的块。它的弱项是精确数字和专有名词——`48小时` 和 `24小时` 向量很近，纯向量容易把两个不同的数字混在一起。这个盲区由词法路补齐，两条路的融合见 [00 的「六 双路 + RRF 融合」](00-RAG从零到双路召回.md)。
