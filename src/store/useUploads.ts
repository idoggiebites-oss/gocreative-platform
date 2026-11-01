// The upload rows: what the customer sees for each file, in step with the server's reserved -> stored states.
import { useCallback, useRef, useState } from 'react'
import { PublicError, SESSION_ENDED, listFiles, removeFile, uploadFile, type FilePurpose, type StoredFile } from './publicApi'
import type { SavedFile } from './orderForm'

export type Row = {
  key: string; name: string; bytes: number; purpose: FilePurpose
  state: 'uploading' | 'done' | 'failed' | 'removing'
  progress: number; error?: string; id?: string; file?: File; preview?: string
  ambiguous?: boolean // the attempt may have reached the server: check before posting it again
}

const MB = 2 ** 20
const MAX_FILES = 5
const MAX_FILE = 20 * MB
const MAX_TOTAL = 60 * MB
const ACCEPTED: Record<FilePurpose, RegExp> = { artwork: /\.(png|jpe?g|pdf|svg)$/i, po: /\.(png|jpe?g|pdf)$/i }
const ACCEPTED_TYPE: Record<FilePurpose, string[]> = { artwork: ['image/png', 'image/jpeg', 'application/pdf', 'image/svg+xml'], po: ['image/png', 'image/jpeg', 'application/pdf'] }

const fits = (file: File, purpose: FilePurpose) => ACCEPTED_TYPE[purpose].includes(file.type) || (!file.type && ACCEPTED[purpose].test(file.name))
const previewOf = (file: File) => (file.type === 'image/png' || file.type === 'image/jpeg' ? URL.createObjectURL(file) : undefined)

export function useUploads(p: { initial: SavedFile[]; ensureToken: () => Promise<string>; currentToken: () => string | null; dropToken: () => void; onClosed: () => void }) {
  const [rows, setRows] = useState<Row[]>(() => p.initial.map((f) => ({ key: f.id, id: f.id, name: f.name, bytes: f.bytes, purpose: f.purpose, state: 'done', progress: 1 })))
  const [notice, setNotice] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [canRestart, setCanRestart] = useState(false)
  const rowsRef = useRef(rows)
  const cancelled = useRef(new Set<string>())
  const tombstones = useRef<{ name: string; bytes: number }[]>([]) // cancelled mid-send: the server may have kept them
  const cancels = useRef(new Map<string, () => void>())
  const patch = useCallback((key: string, change: Partial<Row>) => {
    rowsRef.current = rowsRef.current.map((r) => (r.key === key ? { ...r, ...change } : r))
    setRows(rowsRef.current)
  }, [])
  const drop = useCallback((row: Row) => {
    if (row.preview) URL.revokeObjectURL(row.preview)
    rowsRef.current = rowsRef.current.filter((r) => r.key !== row.key)
    setRows(rowsRef.current)
  }, [])

  /** The session is gone, and its files with it. Rows we still hold a file for can go up again. */
  const sessionEnded = useCallback(() => {
    p.dropToken()
    rowsRef.current = rowsRef.current.map((r) => (r.state === 'done' ? { ...r, id: undefined, state: 'failed', progress: 0, error: r.file ? 'Your session ended, so this file needs to go up again.' : 'Your session ended. Please remove this and add the file again.' } : r))
    setRows(rowsRef.current)
  }, [p])

  /**
   * Makes the rows match what the session really holds, because that is what submit will send. Runs after any failure
   * that may have reached the server, on reload and before sending, so nothing goes out that the customer can't see.
   * False means the session ended.
   */
  const reconcile = useCallback(async () => {
    const token = p.currentToken()
    if (!token) return true
    // Rows finished while the listing is in flight aren't in it; only rows known before it can be judged by it.
    const knownBefore = new Set(rowsRef.current.flatMap((r) => (r.id ? [r.id] : [])))
    let held: StoredFile[]
    try {
      held = (await listFiles(token)).files
    } catch (e) {
      const { code } = e as PublicError
      if (code === 'session_closed') return true // already sent, with only the reply lost: sending again returns the same reference
      if (!SESSION_ENDED.has(code)) throw e
      sessionEnded()
      return false
    }
    const known = new Set(rowsRef.current.flatMap((r) => (r.id ? [r.id] : [])))
    let free = held.filter((f) => !known.has(f.id))
    const claim = (match: (f: (typeof held)[number]) => boolean) => {
      const hit = free.find(match)
      if (hit) free = free.filter((f) => f !== hit)
      return hit
    }
    for (const t of tombstones.current.splice(0)) {
      const hit = claim((f) => f.bytes === t.bytes && f.filename === t.name)
      // A file that won't delete is still going to be sent, so it goes back in the list below and gets a visible row.
      if (hit) await removeFile(token, hit.id).catch(() => { free = [...free, hit] })
    }
    const ids = new Set(held.map((f) => f.id))
    const inFlight = rowsRef.current.some((r) => r.state === 'uploading')
    const next = rowsRef.current.map((r): Row => {
      if (r.state === 'failed' && !r.id) {
        const hit = claim((f) => f.bytes === r.bytes && f.purpose === r.purpose && (f.filename === r.name || !f.filename))
        return hit ? { ...r, id: hit.id, state: 'done', progress: 1, error: undefined, ambiguous: false } : { ...r, ambiguous: false }
      }
      return r.state === 'done' && r.id && knownBefore.has(r.id) && !ids.has(r.id) ? { ...r, id: undefined, state: 'failed', progress: 0, error: r.file ? 'This file did not reach us. Please retry.' : 'This file did not reach us. Please remove it and add it again.' } : r
    })
    // Anything left would be sent unseen. Unless an upload is still running (it may be that upload's), it gets a row.
    const extra: Row[] = inFlight ? [] : free.map((f) => ({ key: f.id, id: f.id, name: f.filename ?? 'Uploaded file', bytes: f.bytes, purpose: f.purpose, state: 'done', progress: 1 }))
    rowsRef.current = [...next, ...extra]
    setRows(rowsRef.current)
    return true
  }, [p, sessionEnded])

  const start = useCallback(async (key: string, file: File, purpose: FilePurpose) => {
    rowsRef.current = rowsRef.current.map((r) => (r.key === key ? { ...r, state: 'uploading', progress: 0, error: undefined, ambiguous: false } : r))
    setRows(rowsRef.current)
    try {
      const token = await p.ensureToken()
      if (cancelled.current.delete(key)) return // cancelled while the session was opening: nothing was sent
      const { done, cancel } = uploadFile({ token, file, purpose, onProgress: (progress) => patch(key, { progress }) })
      cancels.current.set(key, cancel)
      const ack = await done
      if (cancelled.current.delete(key)) {
        await removeFile(token, ack.id).catch(() => tombstones.current.push({ name: ack.filename ?? file.name, bytes: file.size })) // retried, or shown, at the next reconcile
        return
      }
      patch(key, { state: 'done', progress: 1, id: ack.id })
      setAnnouncement(`${file.name} uploaded.`)
    } catch (e) {
      const err = e as PublicError
      if (err.code === 'aborted') return
      if (SESSION_ENDED.has(err.code)) sessionEnded()
      if (err.code === 'intake_closed') p.onClosed()
      if (err.code === 'upload_limit') setCanRestart(true)
      patch(key, { state: 'failed', progress: 0, error: err.message, ambiguous: err.code === 'network' || err.code === 'timeout' })
      setAnnouncement(`${file.name} did not upload. ${err.message}`)
      // The body may have arrived with only the reply lost. If so this row is really fine, and a retry would duplicate it.
      if (err.code === 'network' || err.code === 'timeout') {
        await reconcile().catch(() => {})
        if (rowsRef.current.find((r) => r.key === key)?.state === 'done') setAnnouncement(`${file.name} uploaded.`)
      }
    } finally {
      cancels.current.delete(key)
    }
  }, [p, patch, reconcile, sessionEnded])

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

  const retry = useCallback(async (row: Row) => {
    if (!row.file) return
    if (row.ambiguous) {
      try {
        await reconcile()
      } catch {
        return patch(row.key, { error: 'We still cannot reach the shop. Please try again in a moment.' }) // not knowing, posting again could duplicate it
      }
    }
    const now = rowsRef.current.find((r) => r.key === row.key)
    if (now?.state === 'failed' && now.file) void start(now.key, now.file, now.purpose)
  }, [patch, reconcile, start])

  const remove = useCallback(async (row: Row) => {
    if (row.state === 'uploading') {
      const cancel = cancels.current.get(row.key)
      cancelled.current.add(row.key)
      if (cancel) {
        tombstones.current.push({ name: row.name, bytes: row.bytes }) // the whole body may already have arrived; reconcile removes it
        cancel()
      }
      drop(row)
      setAnnouncement(`${row.name} cancelled.`)
      return
    }
    if (row.state !== 'done' || !row.id) return drop(row)
    patch(row.key, { state: 'removing' })
    try {
      await removeFile(await p.ensureToken(), row.id)
      drop(row)
      setAnnouncement(`${row.name} removed.`)
    } catch (e) {
      const err = e as PublicError
      if (SESSION_ENDED.has(err.code) || err.code === 'not_found') return drop(row)
      // Not removed means it would still be sent, so the row stays and says so.
      patch(row.key, { state: 'done', error: `Could not remove this file. ${err.message}` })
    }
  }, [drop, p, patch])

  /** Past the session's attempt limit, a fresh session (and a fresh Turnstile check) is the way forward. */
  const restart = useCallback(() => {
    setCanRestart(false)
    sessionEnded()
    for (const r of rowsRef.current) if (r.file) void start(r.key, r.file, r.purpose)
  }, [sessionEnded, start])

  const current = useCallback(() => rowsRef.current, [])
  return { rows, notice, announcement, canRestart, add, retry, remove, restart, reconcile, sessionEnded, current }
}
