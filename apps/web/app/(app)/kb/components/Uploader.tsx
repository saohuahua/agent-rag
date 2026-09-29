'use client'

import { useRef, useState } from 'react'
import type { DocSummary } from '@agent-rag/shared'
import { get, uploadDoc, ApiError } from '../../../../lib/api'

/** 状态到进度百分比 终态 100 但失败也停 */
const PROGRESS: Record<string, number> = {
  UPLOADED: 10,
  QUEUED: 30,
  PARSING: 60,
  INDEXED: 100,
  OCR_NEEDED: 100,
  FAILED: 100,
}

/** 终态集合 到达即停止轮询 */
const TERMINAL = new Set(['INDEXED', 'OCR_NEEDED', 'FAILED'])

/**
 * 上传器 选文件后上传并轮询解析状态显示进度条
 * @param datasetId 目标数据集
 * @param onUploaded 上传完成回调 触发文档列表刷新
 */
export function Uploader({ datasetId, onUploaded }: { datasetId: number; onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleFile(file: File) {
    setBusy(true)
    setFileName(file.name)
    setProgress(0)
    setStatus('')
    setError('')

    try {
      const { docId } = await uploadDoc<{ docId: number; status: string }>(datasetId, file)

      // 轮询解析进度 终态或超时停止
      let timer: ReturnType<typeof setInterval> | null = null
      await new Promise<void>((resolve) => {
        timer = setInterval(async () => {
          try {
            const doc = await get<DocSummary>(`/kb/docs/${docId}`)
            setProgress(PROGRESS[doc.status] ?? 0)
            setStatus(doc.status)
            if (TERMINAL.has(doc.status)) {
              if (timer) clearInterval(timer)
              resolve()
            }
          } catch {
            if (timer) clearInterval(timer)
            resolve()
          }
        }, 1000)
      })

      onUploaded()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '上传失败')
    } finally {
      setBusy(false)
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    // 清空 input 允许重复选同一文件
    e.target.value = ''
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <div>
          <div className="card-title" style={{ margin: 0 }}>上传文档</div>
          <p className="hint">支持 PDF / DOCX 单文件 ≤ 20MB 上传后异步解析入库</p>
        </div>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? '上传中…' : '选择文件'}
        </button>
        <input ref={inputRef} type="file" accept=".pdf,.docx" style={{ display: 'none' }} onChange={onPick} />
      </div>

      {fileName && (
        <div style={{ marginTop: 12 }}>
          <div className="row-between">
            <span className="small">{fileName}</span>
            <span className="small muted">{status || '准备中'} · {progress}%</span>
          </div>
          <div style={{ height: 6, background: 'var(--bg-subtle)', borderRadius: 3, marginTop: 6, overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.4s' }} />
          </div>
        </div>
      )}

      {error && <p className="error-text small" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  )
}
