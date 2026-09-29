import type { EmployeeSummary } from '@agent-rag/shared'

/**
 * 员工徽标 显示当前持有会话的员工
 * 头像用名字首字代替 无真实头像资源
 */
export function EmployeeBadge({ employee, dim }: { employee: EmployeeSummary | null; dim?: boolean }) {
  if (!employee) {
    return <span className="badge badge-gray">未分配员工</span>
  }

  const initial = employee.displayName.slice(0, 1)

  return (
    <span
      className="badge badge-blue"
      style={{ opacity: dim ? 0.6 : 1 }}
      title={`${employee.displayName} · ${employee.templateSlug} v${employee.templateVersion}`}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: 'var(--accent)',
          color: '#fff',
          fontSize: 11,
        }}
      >
        {initial}
      </span>
      {employee.displayName}
    </span>
  )
}
