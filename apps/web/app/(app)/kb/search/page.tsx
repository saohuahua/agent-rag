import Link from 'next/link'
import { DualRecall } from '../components/DualRecall'

/**
 * 检索测试台页 双路召回可视化
 * 服务端组件壳 交互全在 DualRecall 客户端组件
 */
export default function SearchPage() {
  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div className="page">
        <div className="row-between">
          <div>
            <h1 className="page-title">检索测试台</h1>
            <p className="page-desc">双路召回并排对比 · 向量路语义 / 词法路关键词 · RRF 融合只看名次</p>
          </div>
          <Link href="/kb" className="btn btn-sm">返回知识库</Link>
        </div>
        <DualRecall />
      </div>
    </div>
  )
}
