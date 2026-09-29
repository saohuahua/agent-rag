'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../../lib/auth'
import { ApiError } from '../../../lib/api'

/**
 * 注册页 创建企业并成为 OWNER 注册成功自动登录跳 chat
 */
export default function RegisterPage() {
  const { me, loading, register } = useAuth()
  const router = useRouter()

  const [enterpriseName, setEnterpriseName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!loading && me) router.replace('/chat')
  }, [loading, me, router])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await register(email, password, enterpriseName)
      router.replace('/chat')
    } catch (err) {
      if (err instanceof ApiError && err.code === 400) {
        setError(err.message.includes('registered') ? '该邮箱已注册' : '注册信息不合法')
      } else {
        setError(err instanceof Error ? err.message : '注册失败')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>注册企业</h1>
        <p className="sub">创建你的企业空间 成为 OWNER</p>

        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="enterpriseName">企业名称</label>
            <input
              id="enterpriseName"
              className="input"
              value={enterpriseName}
              onChange={(e) => setEnterpriseName(e.target.value)}
              placeholder="如 美妆严选旗舰店"
              required
            />
          </div>

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
              placeholder="至少 6 位"
              required
              minLength={6}
              autoComplete="new-password"
            />
          </div>

          {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}

          <button className="btn btn-primary" style={{ width: '100%' }} disabled={submitting || loading} type="submit">
            {submitting ? '注册中…' : '注册并进入'}
          </button>
        </form>

        <p className="hint" style={{ marginTop: 16 }}>
          已有账号 <Link href="/login">去登录</Link>
        </p>
      </div>
    </div>
  )
}
