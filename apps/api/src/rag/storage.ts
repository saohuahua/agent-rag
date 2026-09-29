import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 上传文件本地落盘收口
 * 为什么不用对象存储：个人项目量级 本地磁盘足够 生产换 S3/OSS 只改这一处
 * 目录相对进程 cwd（dev 时 cwd=apps/api）生产部署 cwd 为构建产物目录 同样可用
 */

/** 上传文件根目录 首次写入自动创建 */
export function uploadDir(): string {
  const dir = path.resolve(process.cwd(), 'data', 'uploads')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 把临时文件移动为正式存储键 返回 storageKey（仅文件名 不含路径）
 * 为什么用 uuid 命名：杜绝用户原始文件名的路径穿越与非法字符风险
 * @param srcPath 源文件路径（multer 落盘后的临时文件）
 * @param ext 扩展名（不含点）如 pdf docx
 * @returns 存储键 仅文件名
 */
export function persistUpload(srcPath: string, ext: string): string {
  const key = `${randomUUID()}.${ext}`
  fs.renameSync(srcPath, path.join(uploadDir(), key))
  return key
}

/**
 * 按存储键读回文件字节
 * 为什么 basename 收口：storageKey 只允许是文件名 防路径穿越
 * @param storageKey 存储键（文件名）
 */
export function readUpload(storageKey: string): Buffer {
  return fs.readFileSync(path.join(uploadDir(), path.basename(storageKey)))
}

/**
 * 删除上传文件（去重冲突时清理临时文件）
 * @param storageKey 存储键（文件名）
 */
export function removeUpload(storageKey: string): void {
  const p = path.join(uploadDir(), path.basename(storageKey))
  if (fs.existsSync(p)) fs.unlinkSync(p)
}
