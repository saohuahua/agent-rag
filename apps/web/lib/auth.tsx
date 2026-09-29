'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { MeInfo } from '@agent-rag/shared'
import { get, post } from './api'

/**
 * 登录态上下文 提供当前成员信息与登录/注册/登出动作
 * 挂载时拉一次 /auth/me 判断是否已登录
 * 真实后端 JWT HttpOnly cookie mock 模式 mock cookie 都由 fetch 自动携带
 */

interface AuthContextValue {
  /** 当前登录成员 未登录为 null */
  me: MeInfo | null
  /** 初始判断是否完成 未完成前布局应显示加载态 */
  loading: boolean
  /** 登录 成功后写入 me */
  login: (email: string, password: string) => Promise<void>
  /** 注册 成功后写入 me（注册成功自动登录） */
  register: (email: string, password: string, enterpriseName: string) => Promise<void>
  /** 登出 清除服务端 cookie 后清空 me 跳登录 */
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * 登录态提供者 挂在根布局 全站共享
 * @param children 子树
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeInfo | null>(null)
  const [loading, setLoading] = useState(true)

  // 挂载后探测登录态 401 视为未登录
  useEffect(() => {
    let cancelled = false

    get<MeInfo>('/auth/me')
      .then((info) => {
        if (!cancelled) setMe(info)
      })
      .catch(() => {
        // 未登录或网络失败都视为未登录 具体错误在登录页再暴露
        if (!cancelled) setMe(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const info = await post<MeInfo>('/auth/login', { email, password })
    setMe(info)
  }, [])

  const register = useCallback(async (email: string, password: string, enterpriseName: string) => {
    const info = await post<MeInfo>('/auth/register', { email, password, enterpriseName })
    setMe(info)
  }, [])

  const logout = useCallback(async () => {
    try {
      await post<{ ok: boolean }>('/auth/logout')
    } finally {
      setMe(null)
      if (typeof window !== 'undefined') window.location.assign('/login')
    }
  }, [])

  const value = useMemo(
    () => ({ me, loading, login, register, logout }),
    [me, loading, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/**
 * 读取登录态 hook 必须在 AuthProvider 内使用
 * @throws Error 组件树缺 Provider 时抛出
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return ctx
}
