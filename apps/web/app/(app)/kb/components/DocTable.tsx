import type { DocSummary, DocStatusValue } from '@agent-rag/shared'

/** 状态徽标配色与中文名 */
const STATUS_META: Record<DocStatusValue, { label: string; cls: string }> = {
  UPLOADED: { label: '已上传', cls: 'badge-gray' },
  QUEUED: { label: '排队中', cls: 'badge-gray' },
  PARSING: { label: '解析中', cls: 'badge-amber' },
  INDEXED: { label: '已入库', cls: 'badge-green' },
  OCR_NEEDED: { label: '需 OCR', cls: 'badge-purple' },
  FAILED: { label: '失败', cls: 'badge-red' },
}

/** 字节转可读大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 文档列表表格 状态徽标含失败原因
 * @param docs 文档摘要数组
 */
export function DocTable({ docs }: { docs: DocSummary[] }) {
  if (docs.length === 0) {
    return <div className="empty">暂无文档 上传一份 PDF 试试</div>
  }

  return (
    <div className="card">
      <div className="card-title">文档列表</div>
      <table className="table">
        <thead>
          <tr>
            <th>文档</th>
            <th>状态</th>
            <th>分块</th>
            <th>大小</th>
            <th>上传时间</th>
            <th>失败原因</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => {
            const meta = STATUS_META[d.status]
            return (
              <tr key={d.id}>
                <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</td>
                <td><span className={`badge ${meta.cls}`}>{meta.label}</span></td>
                <td className="mono">{d.chunkCount}</td>
                <td className="muted">{formatSize(d.sizeBytes)}</td>
                <td className="muted small">{new Date(d.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                <td className="error-text small" style={{ color: d.parseError ? 'var(--red)' : 'var(--text-3)' }}>
                  {d.parseError ?? '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
