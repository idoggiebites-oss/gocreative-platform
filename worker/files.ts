// Uploads and downloads (R2). Upload format: the raw file is the request body (not multipart), Content-Type is the
// declared type, X-Filename is encodeURIComponent(file name). Raw keeps one copy of the file in memory (multipart
// parsing holds the body and then the part), which matters with a 50 MB cap under the Worker's 128 MB.
//
// Ordering: R2 put first, then the one D1 batch that inserts the files row with its artwork / po_documents row and
// the activity row. If the batch throws or changes nothing (a stale order version), the R2 object is deleted (best
// effort). So a D1 row never points at a missing object; the worst case, a failed delete, is an R2 object no row
// names, which nothing can serve (downloads look the key up from a files row linked to an order).
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from './auth'
import type { ApiErrorCode } from '../shared/api'
import { getLinkedFile, type NewFile } from './db/files'

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

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

/** SVG = UTF-8 text that is, after an optional BOM, whitespace, XML declaration, comments and a plain DOCTYPE, an <svg> element. */
function isSvg(b: Uint8Array) {
  let s: string
  try {
    // stream: a multi-byte character cut by the 64 KB prefix isn't an error; anything else that isn't UTF-8 is.
    s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b.subarray(0, 64 * 1024), { stream: true })
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

/** Reads at most `max` bytes; 'too_large' as soon as the body goes past it, without buffering the rest. */
async function readBounded(body: ReadableStream<Uint8Array> | null, declared: number | null, max: number): Promise<Uint8Array<ArrayBuffer> | 'too_large'> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  // With a Content-Length the file is read straight into one buffer; without one, chunks are joined at the end.
  // ponytail: the chunked path briefly holds two copies; browsers always send Content-Length for a File body.
  const chunks: Uint8Array[] = []
  const out = declared === null ? null : new Uint8Array(declared)
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (n + value.byteLength > (out ? out.byteLength : max)) {
      await reader.cancel()
      return 'too_large'
    }
    if (out) out.set(value, n)
    else chunks.push(value)
    n += value.byteLength
  }
  if (out) return n === out.byteLength ? out : out.subarray(0, n)
  const joined = new Uint8Array(n)
  let o = 0
  for (const c of chunks) {
    joined.set(c, o)
    o += c.byteLength
  }
  return joined
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('')
const refuse = (c: Context, status: 400 | 411 | 413 | 415, code: ApiErrorCode, error: string) => c.json({ error, code }, status)

/**
 * Validates the request body as an upload of one of `kinds`, stores it in R2, then runs `write` (the D1 batch).
 * Returns the refusal Response, or write's result: null means the batch applied nothing (stale order version),
 * in which case the R2 object has already been deleted. A batch that throws deletes it too, then rethrows.
 */
export async function storeUpload<T>(c: Context<AppEnv>, orderId: number, kinds: readonly FileKind[], write: (file: NewFile) => Promise<T | null>):
  Promise<{ response: Response } | { result: T | null }> {
  const lengthHeader = c.req.header('content-length')
  const declared = lengthHeader === undefined ? null : Number(lengthHeader)
  if (declared !== null && !(Number.isSafeInteger(declared) && declared >= 0)) return { response: refuse(c, 400, 'invalid_request', 'Bad Content-Length') }
  if (declared !== null && declared > MAX_UPLOAD_BYTES) return { response: refuse(c, 413, 'file_too_large', 'File is larger than 50 MB') }
  const bytes = await readBounded(c.req.raw.body, declared, MAX_UPLOAD_BYTES)
  if (bytes === 'too_large') return { response: refuse(c, 413, 'file_too_large', 'File is larger than 50 MB') }
  if (bytes.byteLength === 0) return { response: refuse(c, 400, 'invalid_request', 'Empty upload') }
  const kind = sniff(bytes)
  if (!kind || !kinds.includes(kind)) return { response: refuse(c, 415, 'unsupported_file_type', 'File type not accepted') }
  const mime = FILE_KINDS[kind]
  const claimed = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (claimed !== mime) return { response: refuse(c, 415, 'file_type_mismatch', `Declared ${claimed ?? 'no type'}, content is ${mime}`) }
  let name: string | null = null
  try {
    name = sanitizeFilename(decodeURIComponent(c.req.header('x-filename') ?? ''))
  } catch {
    // A malformed X-Filename is dropped, not fatal: the name is display-only.
  }
  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes))
  // Never derived from the file name: the order, the content hash, and a random suffix (two uploads of one file are two objects).
  const r2Key = `orders/${orderId}/${sha256}-${crypto.randomUUID()}`
  await c.env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: mime }, sha256 })
  const cleanup = () => c.env.FILES.delete(r2Key).catch((e: unknown) => console.error('R2 cleanup failed', r2Key, e))
  let result: T | null
  try {
    result = await write({ r2Key, mime, bytes: bytes.byteLength, sha256, filename: name })
  } catch (e) {
    await cleanup()
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
