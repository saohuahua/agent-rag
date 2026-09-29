'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../../lib/auth'
import { ApiError } from '../../../lib/api'

/**
 * 登录页 表单提交后写入登录态并跳转 chat
 * 已登录访问时自动跳转
 */
export default function LoginPage() {
  const { me, loading, login } = useAuth()
  const router = useRouter()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 已登录直接进 chat
  useEffect(() => {
    if (!loading && me) router.replace('/chat')
  }, [loading, me, router])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await login(email, password)
      router.replace('/chat')
    } catch (err) {
      // 登录失败统一给中文提示 技术细节保留英文便于搜索
      if (err instanceof ApiError && err.code === 400) {
        setError('邮箱或密码错误')
      } else {
        setError(err instanceof Error ? err.message : '登录失败')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>登录</h1>
        <p className="sub">硅基员工平台 · 企业 AI 中台</p>

        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="email">邮箱</label>
            <input
              id="email"
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              autoComplete="email"
            />
          </div>

          <div className="field">
            <label htmlFor="password">密码</label>
            <input
              id="password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              required
              autoComplete="current-password"
            />
          </div>

          {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}

          <button className="btn btn-primary" style={{ width: '100%' }} disabled={submitting || loading} type="submit">
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>

        <p className="hint" style={{ marginTop: 16 }}>
          还没有账号 <Link href="/register">去注册</Link>
        </p>

        <p className="hint" style={{ marginTop: 8 }}>
          演示账号 owner1@demo.com / owner2@demo.com 密码 123456
        </p>
      </div>
    </div>
  )
}
