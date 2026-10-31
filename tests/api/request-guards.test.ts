// Codex Phase 2 security review: writes must come from this site (the Access cookie rides along on a cross-site
// request), and request bodies are capped before they are read (uploads stream under their own limit).
import { Hono } from 'hono'
import { expect, test } from 'vitest'
import type { AppEnv } from '../../worker/auth'
import { appRoutes } from '../../worker/routes/app'
import { createTestD1 } from './d1'
import { readFileSync } from 'node:fs'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
function setup() {
  const { db, sqlite } = createTestD1()
  sqlite.exec(seed)
  const app = new Hono<AppEnv>().route('/api/app', appRoutes())
  const send = (path: string, init: RequestInit) => app.request(`http://localhost/api/app${path}`, init, { DB: db, DEV_AUTH_EMAIL: 'owner1@example.com' })
  const customers = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n
  return { send, customers }
}
const body = JSON.stringify({ name: 'Forged Customer', kind: 'individual' })

test('a cross-site write is refused before anything is read or written, whatever its content type', async () => {
  const t = setup()
  const n = t.customers()
  for (const headers of [
    { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
    { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    { Origin: 'https://evil.example' }, // no content type at all: still a simple request
    { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'cross-site' },
    { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'same-site' },
  ]) {
    const res = await t.send('/customers', { method: 'POST', headers, body })
    expect([res.status, (await res.json()).code], JSON.stringify(headers)).toEqual([403, 'cross_site_request'])
  }
  expect(t.customers()).toBe(n)
  // Same-origin writes (and reads from anywhere) still work.
  expect((await t.send('/customers', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' }, body })).status).toBe(201)
  expect((await t.send('/customers', { method: 'GET', headers: { Origin: 'https://evil.example' } })).status).toBe(200)
})

test('a body over 256 KB is refused before parsing, with or without Content-Length; uploads are exempt', async () => {
  const t = setup()
  const n = t.customers()
  const big = JSON.stringify({ name: 'Big', kind: 'individual', pad: 'x'.repeat(300 * 1024) })
  const res = await t.send('/customers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big })
  expect([res.status, (await res.json()).code]).toEqual([413, 'body_too_large'])
  const stream = new Blob([big]).stream()
  const chunked = await t.send('/customers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit)
  expect(chunked.status).toBe(413)
  expect(t.customers()).toBe(n)
  // An upload path is not capped here (files.ts streams it under its own limit): it gets past this middleware.
  const up = await t.send('/orders/2026-0005/artwork?expectedVersion=0', { method: 'POST', headers: { 'Content-Type': 'image/png', 'Content-Length': String(300 * 1024) }, body: new Uint8Array(300 * 1024) })
  expect(up.status).not.toBe(413)
})
