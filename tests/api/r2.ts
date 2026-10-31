// In-memory R2 for the API tests (put/get/delete, what worker/files.ts uses, with a log of each call), and the
// harness the upload tests share: the seeded D1 and this R2 behind the real /api/app routes.
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { appRoutes } from '../../worker/routes/app'
import type { AppEnv } from '../../worker/auth'
import { createTestD1 } from './d1'

export function createTestR2() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  const calls: [op: 'put' | 'get' | 'delete', key: string][] = []
  const bucket = {
    // A stream is read to the end first: if it errors (a body shorter or longer than its declared length), nothing is stored.
    put: async (key: string, value: ArrayBufferView | ReadableStream<Uint8Array>, opts?: { httpMetadata?: { contentType?: string } }) => {
      calls.push(['put', key])
      const bytes = value instanceof ReadableStream
        ? new Uint8Array(await new Response(value).arrayBuffer())
        : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
      objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType })
      return { key, size: bytes.byteLength }
    },
    get: async (key: string) => {
      calls.push(['get', key])
      const o = objects.get(key)
      if (!o) return null
      return { key, size: o.bytes.byteLength, body: new Blob([o.bytes as Uint8Array<ArrayBuffer>]).stream(), httpMetadata: { contentType: o.contentType } }
    },
    delete: async (key: string) => {
      calls.push(['delete', key])
      objects.delete(key)
    },
  }
  // Cast: the real R2Bucket type comes from workers-types; this covers the three methods the Worker calls.
  return { bucket: bucket as unknown as Env['FILES'], objects, calls }
}

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
const text = (s: string) => new TextEncoder().encode(s)

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0])
export const TIFF_LE = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])
export const TIFF_BE = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8])
export const PDF = text('%PDF-1.7\n1 0 obj << >> endobj\n')
export const SVG = text('﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: test -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>')
export const HTML = text('<!doctype html><html><body><script>alert(1)</script></body></html>')
export const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 3, 0, 0, 0])

export function setupUploads() {
  const { db, sqlite } = createTestD1()
  sqlite.exec(seed)
  const r2 = createTestR2()
  const app = new Hono<AppEnv>().route('/api/app', appRoutes())
  const env = (auth: boolean, DB = db) => (auth
    ? { DB, FILES: r2.bucket, DEV_AUTH_EMAIL: 'owner1@example.com' }
    : { DB, FILES: r2.bucket, ACCESS_AUD: 'a', ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com' })
  const json = (method: string, path: string, body?: unknown, auth = true) =>
    app.request(`http://localhost/api/app${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) }, env(auth))
  // Content-Length is the body's length unless `length` says otherwise (null: no header, as a chunked upload sends).
  const upload = (path: string, bytes: Uint8Array, type: string, opts: { filename?: string; auth?: boolean; DB?: typeof db; length?: string | number | null } = {}) =>
    app.request(`http://localhost/api/app${path}`, {
      method: 'POST', body: bytes as Uint8Array<ArrayBuffer>,
      headers: {
        'Content-Type': type, ...(opts.filename === undefined ? {} : { 'X-Filename': encodeURIComponent(opts.filename) }),
        ...(opts.length === null ? {} : { 'Content-Length': String(opts.length ?? bytes.byteLength) }),
      },
    }, env(opts.auth ?? true, opts.DB ?? db))
  const get = (path: string, auth = true) => app.request(`http://localhost/api/app${path}`, {}, env(auth))
  const one = <T>(sql: string, ...p: (string | number)[]) => sqlite.prepare(sql).get(...p) as T
  const count = (sql: string, ...p: (string | number)[]) => one<{ n: number }>(sql, ...p).n
  const order = (n: string) => one<{ id: number; version: number; production_status: string }>('SELECT id, version, production_status FROM orders WHERE number = ?', n)
  const activity = (orderId: number) => sqlite.prepare('SELECT action, before, after FROM activity_log WHERE entity_type = ? AND entity_id = ? ORDER BY id').all('order', orderId) as { action: string; before: string | null; after: string | null }[]
  /** Row counts and R2 objects: a refused write changes none of them. */
  const footprint = () => ({
    files: count('SELECT COUNT(*) AS n FROM files'), artwork: count('SELECT COUNT(*) AS n FROM artwork'), poDocs: count('SELECT COUNT(*) AS n FROM po_documents'),
    pos: count('SELECT COUNT(*) AS n FROM purchase_orders'), activity: count('SELECT COUNT(*) AS n FROM activity_log'), r2: r2.objects.size,
  })
  return { db, sqlite, r2, json, upload, get, one, count, order, activity, footprint }
}
export type Uploads = ReturnType<typeof setupUploads>
