import { redirect } from 'next/navigation'

/** 管理入口 默认落到模板页 */
export default function AdminIndex() {
  redirect('/admin/templates')
}
