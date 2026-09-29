import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { AuthProvider } from '../lib/auth'
import './globals.css'

/** 站点元信息 */
export const metadata: Metadata = {
  title: '硅基员工平台',
  description: '企业 AI 中台 电商数字员工演示',
}

/**
 * 根布局 全站挂 AuthProvider 让登录态贯穿所有页面
 * @param children 子树
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  )
}
