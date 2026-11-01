// The browser's side of /api/public. Every failure becomes a typed PublicError with a message a customer can act on.
import { runTurnstile } from './turnstile'

export type Status = { open: boolean; turnstileSiteKey: string | null }
export type FilePurpose = 'artwork' | 'po'
export type UploadAck = { id: string; filename: string | null; bytes: number }

export class PublicError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}
export const SESSION_ENDED = new Set(['session_invalid', 'session_expired'])

const offline = () => new PublicError('network', 'We could not reach the shop. Check your connection and try again.')
const timedOut = () => new PublicError('timeout', 'That took too long. Check your connection and try again.')
const FRIENDLY: Record<string, string> = {
  file_too_large: 'That file is over the 20 MB limit.',
  unsupported_file_type: 'That file type is not accepted. Use PNG, JPG, PDF or SVG (a purchase order can be PDF, PNG or JPG).',
  file_type_mismatch: 'That file does not match its type. Try saving it again as PNG, JPG or PDF.',
  invalid_request: 'Something in the form needs another look.',
  upload_limit: 'We cannot take this file on this request. It may be over the limit, or there have been too many tries.',
}

function fromBody(status: number, body: { code?: string; error?: string }) {
  const code = body.code ?? `http_${status}`
  return new PublicError(code, FRIENDLY[code] ?? body.error ?? 'Something went wrong on our side. Please try again.')
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/public${path}`, { ...init, signal: AbortSignal.timeout(20_000) })
  } catch (e) {
    throw e instanceof DOMException && e.name === 'TimeoutError' ? timedOut() : offline()
  }
  const body = await res.json().catch(() => ({})) as T & { code?: string; error?: string }
  if (!res.ok) throw fromBody(res.status, body)
  return body
}

export const fetchStatus = () => json<Status>('/status')

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

/** Spends one Turnstile token to open a session. The session then lasts 2 hours. */
export async function openSession(siteKey: string | null) {
  const turnstileToken = siteKey ? await runTurnstile(siteKey) : 'local'
  const { token } = await json<{ token: string }>('/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnstileToken }) })
  return token
}

/** The type the server will sniff. iOS can leave file.type empty; the name is only a hint, and the server decides. */
function contentType(file: File) {
  if (file.type) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase()
  return ext === 'png' ? 'image/png' : ext === 'pdf' ? 'application/pdf' : ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream'
}

/** XHR, because fetch can't report upload progress. The deadline matches the server's 10 minutes. */
export function uploadFile(p: { token: string; file: File; purpose: FilePurpose; onProgress: (fraction: number) => void }) {
  const xhr = new XMLHttpRequest()
  const done = new Promise<UploadAck>((resolve, reject) => {
    xhr.open('POST', '/api/public/submissions/files')
    xhr.timeout = 10 * 60_000
    xhr.setRequestHeader('Authorization', `Bearer ${p.token}`)
    xhr.setRequestHeader('Content-Type', contentType(p.file))
    xhr.setRequestHeader('X-File-Purpose', p.purpose)
    xhr.setRequestHeader('X-Filename', encodeURIComponent(p.file.name))
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) p.onProgress(e.loaded / e.total) }
    xhr.onerror = () => reject(offline())
    xhr.ontimeout = () => reject(new PublicError('timeout', 'That file took too long to upload. Please try again on a better connection.'))
    xhr.onabort = () => reject(new PublicError('aborted', 'Cancelled.'))
    xhr.onload = () => {
      let body: unknown = {}
      try { body = JSON.parse(xhr.responseText) } catch { /* a non-JSON error page is still an error */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadAck)
      else reject(fromBody(xhr.status, body as { code?: string; error?: string }))
    }
    xhr.send(p.file)
  })
  return { done, cancel: () => xhr.abort() }
}

export type StoredFile = { id: string; filename: string | null; bytes: number; purpose: FilePurpose }
export const listFiles = (token: string) => json<{ files: StoredFile[] }>('/submissions/files', { headers: bearer(token) })

export const removeFile = (token: string, id: string) => json<{ ok: true }>(`/submissions/files/${encodeURIComponent(id)}`, { method: 'DELETE', headers: bearer(token) })

export const submitInquiry = (token: string, form: unknown) =>
  json<{ ref: string }>('/submissions/submit', { method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: JSON.stringify(form) })

