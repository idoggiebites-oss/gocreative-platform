// The upload rows: what the customer sees for each file, in step with the server's reserved -> stored states.
import { useCallback, useRef, useState } from 'react'
import { PublicError, SESSION_ENDED, removeFile, uploadFile, type FilePurpose } from './publicApi'
import type { SavedFile } from './orderForm'

export type Row = {
  key: string; name: string; bytes: number; purpose: FilePurpose
  state: 'uploading' | 'done' | 'failed' | 'removing'
  progress: number; error?: string; id?: string; file?: File; preview?: string
}

const MB = 2 ** 20
const MAX_FILES = 5
const MAX_FILE = 20 * MB
const MAX_TOTAL = 60 * MB
const ACCEPTED: Record<FilePurpose, RegExp> = { artwork: /\.(png|jpe?g|pdf|svg)$/i, po: /\.(png|jpe?g|pdf)$/i }
const ACCEPTED_TYPE: Record<FilePurpose, string[]> = { artwork: ['image/png', 'image/jpeg', 'application/pdf', 'image/svg+xml'], po: ['image/png', 'image/jpeg', 'application/pdf'] }

const fits = (file: File, purpose: FilePurpose) => ACCEPTED_TYPE[purpose].includes(file.type) || (!file.type && ACCEPTED[purpose].test(file.name))
const previewOf = (file: File) => (file.type === 'image/png' || file.type === 'image/jpeg' ? URL.createObjectURL(file) : undefined)

export function useUploads(p: { initial: SavedFile[]; ensureToken: () => Promise<string>; dropToken: () => void; onClosed: () => void }) {
  const [rows, setRows] = useState<Row[]>(() => p.initial.map((f) => ({ key: f.id, id: f.id, name: f.name, bytes: f.bytes, purpose: f.purpose, state: 'done', progress: 1 })))
  const [notice, setNotice] = useState('')
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const cancels = useRef(new Map<string, () => void>())
  const patch = useCallback((key: string, change: Partial<Row>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...change } : r))), [])
  const drop = useCallback((row: Row) => {
    if (row.preview) URL.revokeObjectURL(row.preview)
    setRows((all) => all.filter((r) => r.key !== row.key))
  }, [])

  /** The session is gone, and its files with it. Rows we still hold a file for can go up again. */
  const sessionEnded = useCallback(() => {
    p.dropToken()
    setRows((all) => all.map((r) => (r.state === 'done' ? { ...r, id: undefined, state: 'failed', progress: 0, error: r.file ? 'Your session ended, so this file needs to go up again.' : 'Your session ended. Please remove this and add the file again.' } : r)))
  }, [p])

  const start = useCallback(async (key: string, file: File, purpose: FilePurpose) => {
    patch(key, { state: 'uploading', progress: 0, error: undefined })
    try {
      const token = await p.ensureToken()
      const { done, cancel } = uploadFile({ token, file, purpose, onProgress: (progress) => patch(key, { progress }) })
      cancels.current.set(key, cancel)
      const ack = await done
      patch(key, { state: 'done', progress: 1, id: ack.id })
    } catch (e) {
      const err = e as PublicError
      if (err.code === 'aborted') return
      if (SESSION_ENDED.has(err.code)) sessionEnded()
      if (err.code === 'intake_closed') p.onClosed()
      patch(key, { state: 'failed', progress: 0, error: err.message })
    } finally {
      cancels.current.delete(key)
    }
  }, [p, patch, sessionEnded])

  const add = useCallback((files: File[], purpose: FilePurpose) => {
    // Outside the state updater: StrictMode runs updaters twice, and an upload must start once.
    const next = [...rowsRef.current]
    const refused: string[] = []
    const started: [string, File][] = []
    for (const file of files) {
      const live = next.filter((r) => r.state !== 'failed')
      if (!fits(file, purpose)) refused.push(`${file.name}: ${purpose === 'po' ? 'a purchase order can be PDF, PNG or JPG' : 'use PNG, JPG, PDF or SVG'}.`)
      else if (file.size === 0) refused.push(`${file.name}: this file is empty.`)
      else if (file.size > MAX_FILE) refused.push(`${file.name}: over the 20 MB limit.`)
      else if (live.length >= MAX_FILES) refused.push(`${file.name}: you can send up to ${MAX_FILES} files.`)
      else if (live.reduce((n, r) => n + r.bytes, 0) + file.size > MAX_TOTAL) refused.push(`${file.name}: all your files together can be up to 60 MB.`)
      else {
        const key = crypto.randomUUID()
        next.push({ key, name: file.name, bytes: file.size, purpose, state: 'uploading', progress: 0, file, preview: previewOf(file) })
        started.push([key, file])
      }
    }
    rowsRef.current = next
    setRows(next)
    setNotice(refused.join(' '))
    for (const [key, file] of started) void start(key, file, purpose)
  }, [start])

  const retry = useCallback((row: Row) => { if (row.file) void start(row.key, row.file, row.purpose) }, [start])

  const remove = useCallback(async (row: Row) => {
    if (row.state === 'uploading') {
      cancels.current.get(row.key)?.()
      drop(row)
      return
    }
    if (row.state !== 'done' || !row.id) return drop(row)
    patch(row.key, { state: 'removing' })
    try {
      await removeFile(await p.ensureToken(), row.id)
      drop(row)
    } catch (e) {
      const err = e as PublicError
      if (SESSION_ENDED.has(err.code) || err.code === 'not_found') return drop(row)
      // Not removed means it would still be sent, so the row stays and says so.
      patch(row.key, { state: 'done', error: `Could not remove this file. ${err.message}` })
    }
  }, [drop, p, patch])

  return { rows, notice, add, retry, remove, sessionEnded }
}
