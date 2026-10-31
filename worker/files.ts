// Uploads and downloads (R2). Upload format: the raw file is the request body (not multipart), Content-Type is the
// declared type, X-Filename is encodeURIComponent(file name), and Content-Length is required. The body is streamed
// into R2, never buffered: only the first SNIFF_BYTES are held, to check the type, and the SHA-256 is computed as the
// bytes pass (Codex security review of 1729ff4: a 50 MB buffer per request could exhaust the Worker's 128 MB).
//
// Ordering: R2 put first, then the one D1 batch that inserts the files row with its artwork / po_documents row and
// the activity row. The object is deleted only when the batch certainly did NOT commit: it returned and the guarded
// files INSERT changed no row (a stale order version), or it threw a constraint error (SQLite aborted the
// transaction). On any other failure (a dropped connection, a timeout) the object is kept: an object no row names is
// harmless (nothing can serve it; downloads look the key up from a files row linked to an order), while a row naming
// a deleted object breaks the order. Reads after the batch (the order's new state) are the caller's, after this.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from './auth'
import type { ApiErrorCode } from '../shared/api'
import { getLinkedFile, type NewFile } from './db/files'

/** The one upload cap (the 413 and the UI's message). Streaming holds no copy of the file, so it can rise. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
/** How much of the file's start is held to sniff its type. An SVG must reach its <svg> element within it. */
export const SNIFF_BYTES = 4096

export const FILE_KINDS = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  svg: 'image/svg+xml',
} as const
export type FileKind = keyof typeof FILE_KINDS
export const ARTWORK_KINDS: readonly FileKind[] = ['png', 'jpeg', 'tiff', 'pdf', 'svg']
// SVG is artwork only: a PO document is a scan or a PDF.
export const PO_DOCUMENT_KINDS: readonly FileKind[] = ['png', 'jpeg', 'tiff', 'pdf']

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x)

/**
 * SVG = UTF-8 text that is, after an optional BOM, whitespace, XML declaration, comments and a plain DOCTYPE, an <svg>
 * element, all within the first SNIFF_BYTES. ponytail: a prolog longer than 4 KB is refused as not-SVG; real exports'
 * prologs are a few hundred bytes. If one isn't, raise SNIFF_BYTES (it is held in memory, once per request).
 */
function isSvg(b: Uint8Array) {
  let s: string
  try {
    // stream: a multi-byte character cut by the prefix isn't an error; anything else that isn't UTF-8 is.
    s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b.subarray(0, SNIFF_BYTES), { stream: true })
  } catch {
    return false
  }
  s = s.trimStart()
  if (s.startsWith('<?xml')) {
    const end = s.indexOf('?>')
    if (end < 0) return false
    s = s.slice(end + 2)
  }
  for (;;) {
    s = s.trimStart()
    if (s.startsWith('<!--')) {
      const end = s.indexOf('-->')
      if (end < 0) return false
      s = s.slice(end + 3)
    } else if (/^<!DOCTYPE\s+svg\b[^>[]*>/i.test(s)) {
      s = s.replace(/^<!DOCTYPE[^>]*>/i, '')
    } else break
  }
  return /^<svg[\s>]/.test(s)
}

/** The file's type from its first bytes, or null for anything outside the allowlist (HTML, executables, …). */
export function sniff(b: Uint8Array): FileKind | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff'
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf' // %PDF-
  return isSvg(b) ? 'svg' : null
}

/** The uploader's name for display and Content-Disposition only: no path, control or bidi characters, quotes, at most 200 characters. */
export function sanitizeFilename(raw: string | null | undefined): string | null {
  if (!raw) return null
  const base = raw.split(/[\\/]/).pop() ?? ''
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = Array.from(base.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f"\\;\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim()).slice(0, 200).join('').trim()
  return clean && clean !== '.' && clean !== '..' ? clean : null
}

const rfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
export function contentDisposition(kind: 'inline' | 'attachment', filename: string | null) {
  if (!filename) return kind
  return `${kind}; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${rfc5987(filename)}`
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('')
const refuse = (c: Context, status: 400 | 411 | 413 | 415, code: ApiErrorCode, error: string) => c.json({ error, code }, status)
const joinChunks = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, x) => n + x.byteLength, 0))
  let o = 0
  for (const x of chunks) {
    out.set(x, o)
    o += x.byteLength
  }
  return out
}

/** A D1 error that means SQLite aborted the batch's transaction, so nothing in it committed. */
export const isDefiniteRollback = (e: unknown) => /constraint failed|SQLITE_CONSTRAINT/.test(e instanceof Error ? e.message : String(e))

/**
 * Validates the request as an upload of one of `kinds` (exactly Content-Length bytes), streams it into R2, then runs
 * `write` (the D1 batch). Returns the refusal Response, or write's result: null means the batch committed nothing
 * (stale order version), and the R2 object has been deleted. A batch that throws deletes it only on a definite
 * rollback (see the header), then rethrows.
 */
export async function storeUpload<T>(c: Context<AppEnv>, orderId: number, kinds: readonly FileKind[], write: (file: NewFile) => Promise<T | null>):
  Promise<{ response: Response } | { result: T | null }> {
  const lengthHeader = c.req.header('content-length')
  const length = lengthHeader && /^\d{1,16}$/.test(lengthHeader) ? Number(lengthHeader) : NaN
  if (!Number.isSafeInteger(length)) return { response: refuse(c, 411, 'length_required', 'Content-Length is required') }
  if (length > MAX_UPLOAD_BYTES) return { response: refuse(c, 413, 'file_too_large', `File is larger than ${MAX_UPLOAD_BYTES / 2 ** 20} MB`) }
  const body = c.req.raw.body
  if (length === 0 || !body) return { response: refuse(c, 400, 'invalid_request', 'Empty upload') }
  const incomplete = () => refuse(c, 400, 'invalid_request', 'The body is not Content-Length bytes long')

  // The head: just enough chunks to hold SNIFF_BYTES (or the whole file, if smaller).
  const reader = body.getReader()
  const head: Uint8Array[] = []
  let received = 0
  try {
    while (received < Math.min(SNIFF_BYTES, length)) {
      const { done, value } = await reader.read()
      if (done) break
      head.push(value)
      received += value.byteLength
    }
  } catch {
    return { response: incomplete() }
  }
  if (received > length || (received < SNIFF_BYTES && received !== length)) {
    await reader.cancel().catch(() => {})
    return { response: incomplete() }
  }
  const kind = sniff(joinChunks(head).subarray(0, SNIFF_BYTES))
  const mime = kind && FILE_KINDS[kind]
  const claimed = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase()
  const refusal = !kind || !kinds.includes(kind) ? refuse(c, 415, 'unsupported_file_type', 'File type not accepted')
    : claimed !== mime ? refuse(c, 415, 'file_type_mismatch', `Declared ${claimed ?? 'no type'}, content is ${mime}`) : null
  if (refusal || !mime) {
    await reader.cancel().catch(() => {})
    return { response: refusal! }
  }
  let name: string | null = null
  try {
    name = sanitizeFilename(decodeURIComponent(c.req.header('x-filename') ?? ''))
  } catch {
    // A malformed X-Filename is dropped, not fatal: the name is display-only.
  }

  // The head, then the rest of the body, each chunk hashed on its way through. The source errors (so the R2 put
  // fails and stores nothing) if the body ends short of Content-Length or runs past it; FixedLengthStream, which
  // gives R2 the length it needs for a stream, refuses a mismatch too.
  const digest = new crypto.DigestStream('SHA-256')
  const hash = digest.getWriter()
  let bodyFailed = false
  const fail = (ctl: ReadableStreamDefaultController<Uint8Array>, why: string) => {
    bodyFailed = true
    ctl.error(new Error(why))
    return reader.cancel().catch(() => {})
  }
  const source = new ReadableStream<Uint8Array>({
    async start(ctl) {
      for (const chunk of head) {
        await hash.write(chunk)
        ctl.enqueue(chunk)
      }
    },
    async pull(ctl) {
      const r = await reader.read().catch(() => null)
      if (!r) return fail(ctl, 'request body failed')
      if (r.done) {
        if (received !== length) return fail(ctl, 'body shorter than Content-Length')
        await hash.close()
        return ctl.close()
      }
      received += r.value.byteLength
      if (received > length) return fail(ctl, 'body longer than Content-Length')
      await hash.write(r.value)
      ctl.enqueue(r.value)
    },
    cancel: (reason) => reader.cancel(reason),
  })
  const fixed = new FixedLengthStream(length)
  const pumped = source.pipeTo(fixed.writable).then(() => true, () => false)
  // A random key, never derived from the file name or (unknown until the end) its hash.
  const r2Key = `orders/${orderId}/${crypto.randomUUID()}`
  const cleanup = () => c.env.FILES.delete(r2Key).catch((e: unknown) => console.error('R2 cleanup failed', r2Key, e))
  try {
    await c.env.FILES.put(r2Key, fixed.readable, { httpMetadata: { contentType: mime } })
  } catch (e) {
    // A failed put stores nothing; the delete is for an object some error left behind regardless. The client's
    // fault (a body that broke or didn't match Content-Length) is a 400; anything else (R2 itself) a 500.
    await cleanup()
    if (bodyFailed) return { response: incomplete() }
    throw e
  }
  if (!(await pumped) || bodyFailed || received !== length) {
    await cleanup()
    return { response: incomplete() }
  }
  const sha256 = hex(await digest.digest)

  let result: T | null
  try {
    result = await write({ r2Key, mime, bytes: length, sha256, filename: name })
  } catch (e) {
    if (isDefiniteRollback(e)) await cleanup()
    else console.error('Upload batch outcome unknown; keeping the R2 object', r2Key)
    throw e
  }
  if (result === null) await cleanup()
  return { result }
}

const SERVABLE = new Set<string>(Object.values(FILE_KINDS))
// No script, no plugin, no network: a file opened directly can only show itself.
export const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"

/** GET /files/:id — authenticated (both roles), and only files an artwork version or PO document links to an order. */
export function fileRoutes() {
  return new Hono<AppEnv>().get('/files/:id', async (c) => {
    const id = z.string().regex(/^[1-9]\d{0,14}$/).transform(Number).safeParse(c.req.param('id'))
    const notFound = () => c.json({ error: 'File not found', code: 'not_found' satisfies ApiErrorCode }, 404)
    if (!id.success) return notFound()
    const f = await getLinkedFile(c.env.DB, id.data)
    if (!f) return notFound()
    const obj = await c.env.FILES.get(f.r2_key)
    if (!obj) return notFound()
    // The stored type is the sniffed one; anything else (a pre-M2 row) is served as an opaque download.
    const servable = SERVABLE.has(f.mime)
    // SVG is only ever shown through <img> (where scripts can't run); opened directly it downloads.
    const attachment = !servable || f.mime === 'image/svg+xml' || c.req.query('download') === '1'
    return new Response(obj.body, {
      headers: {
        'Content-Type': servable ? f.mime : 'application/octet-stream',
        'Content-Length': String(obj.size),
        'Content-Disposition': contentDisposition(attachment ? 'attachment' : 'inline', f.filename),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': FILE_CSP,
        'Cache-Control': 'private, max-age=0',
      },
    })
  })
}
