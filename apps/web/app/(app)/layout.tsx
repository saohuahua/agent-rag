'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../../lib/auth'

/** 导航项 前缀用于高亮匹配 */
const NAV = [
  { href: '/chat', label: '会话', prefix: '/chat' },
  { href: '/kb', label: '知识库', prefix: '/kb' },
  { href: '/admin/templates', label: '管理', prefix: '/admin' },
  { href: '/ops', label: '运营', prefix: '/ops' },
]

/**
 * 应用壳 登录态导航
 * 未登录重定向 login 未就绪显示加载态
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { me, loading, logout } = useAuth()
  const pathname = usePathname()
  const router = useRouter()

  // 未登录跳登录页
  useEffect(() => {
    if (!loading && !me) router.replace('/login')
  }, [loading, me, router])

  if (loading || !me) {
    return (
      <div className="auth-shell">
        <div className="spin" />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">硅基员工平台</span>
        <nav>
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={pathname.startsWith(n.prefix) ? 'active' : ''}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="userbox">
          <span>{me.enterpriseName}</span>
          <span className="muted">·</span>
          <span>{me.displayName}</span>
          <button className="btn btn-sm" onClick={() => logout()}>退出</button>
        </div>
      </header>
      <main style={{ overflow: 'hidden', height: 'calc(100vh - 56px)' }}>{children}</main>
    </div>
  )
}
