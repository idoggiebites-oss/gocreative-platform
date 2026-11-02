// Public intake on workerd and real D1, where batch semantics, row-value SQL and the triggers are the real thing. Turnstile
// is the one piece not exercised: a session row is planted directly, with a known token.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { unstable_dev } from 'wrangler'

const dir = mkdtempSync(join(tmpdir(), 'gocreative-public-'))
const config = join(dir, 'wrangler.json')
let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined
const TOKEN = 'k'.repeat(43)
const sql = (command: string) => (JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'gocreative', '--local', '--persist-to', dir, '-c', config, '--json', '--command', command], { encoding: 'utf8', stdio: 'pipe' })) as { results: Record<string, unknown>[] }[])[0].results
const plant = (id: string, token: string, expires = '2999-01-01T00:00:00.000Z') =>
  sql(`INSERT INTO inquiry_submissions (id, token_hash, ip_hash, expires_at) VALUES ('${id}', '${createHash('sha256').update(token).digest('hex')}', 'ip', '${expires}')`)

beforeAll(async () => {
  writeFileSync(config, JSON.stringify({
    name: 'gocreative-public-test', main: resolve('worker/index.ts'), compatibility_date: '2026-10-01',
    d1_databases: [{ binding: 'DB', database_name: 'gocreative', database_id: 'local-test', migrations_dir: resolve('migrations') }],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'gocreative-files' }],
    vars: { IP_HASH_SALT: 'salt', TURNSTILE_SECRET: 'unused' },
  }))
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'gocreative', '--local', '--persist-to', dir, '-c', config], { stdio: 'pipe' })
  worker = await unstable_dev(resolve('worker/index.ts'), {
    config, persistTo: dir, ip: '127.0.0.1', port: 0, logLevel: 'none',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, testScheduled: true },
  })
}, 90_000)
afterAll(async () => {
  await worker?.stop()
  rmSync(dir, { recursive: true, force: true })
})

const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${worker!.port}/api/public${path}`, init)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const upload = (token: string) => api('/submissions/files', { method: 'POST', body: PNG, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'X-File-Purpose': 'artwork', 'Content-Length': String(PNG.length), 'X-Filename': 'logo.png' } })
const FORM = { customerKind: 'organization', contactName: 'Pat', contactPhone: '555-010-0000', lines: [{ product: 'hats', method: 'embroidery', quantity: 4 }] }
const submit = (token: string) => api('/submissions/submit', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(FORM) })

test('ships closed on a freshly migrated database', async () => {
  expect(await (await api('/status')).json()).toEqual({ open: false, turnstileSiteKey: null, estimates: false })
  expect((await upload(TOKEN)).status).toBe(503)
  expect((await api('/nope')).status).toBe(404)
  sql("DELETE FROM settings WHERE key = 'intake_closed'")
})

test('upload, parallel submits, retry: one inquiry, one audit row, the file linked', async () => {
  plant('real', TOKEN)
  expect((await upload(TOKEN)).status).toBe(201)
  const replies = await Promise.all([submit(TOKEN), submit(TOKEN), submit(TOKEN)])
  const refs = new Set(await Promise.all(replies.map(async (r) => ((await r.json()) as { ref: string }).ref)))
  expect(refs.size).toBe(1)
  expect(sql('SELECT COUNT(*) AS n FROM inquiries')).toEqual([{ n: 1 }])
  expect(sql("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'inquiry_received'")).toEqual([{ n: 1 }])
  expect(sql('SELECT i.status, f.via_portal, f.filename FROM inquiry_files i JOIN files f ON f.id = i.file_id')).toEqual([{ status: 'linked', via_portal: 1, filename: 'logo.png' }])
  expect(sql("SELECT status FROM inquiry_submissions WHERE id = 'real'")).toEqual([{ status: 'submitted' }])
  expect(sql('SELECT bytes FROM intake_usage')).toEqual([{ bytes: PNG.length }]) // settle charged exactly what was stored
  expect((await upload(TOKEN)).status).toBe(409)
  expect(sql('SELECT bytes FROM intake_usage')).toEqual([{ bytes: PNG.length }]) // a refused upload charged nothing
}, 60_000)

test('parallel uploads on real D1 stop at the cap', async () => {
  const token = 'c'.repeat(43)
  plant('capped', token)
  const results = await Promise.all(Array.from({ length: 8 }, () => upload(token)))
  expect(results.filter((r) => r.status === 201).length).toBe(5)
}, 60_000)

test('the real cron trigger clears an abandoned session and leaves the submitted one', async () => {
  const token = 'a'.repeat(43)
  plant('abandoned', token)
  expect((await upload(token)).status).toBe(201)
  sql("DROP TRIGGER submissions_identity_fixed; UPDATE inquiry_submissions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id IN ('abandoned', 'real')")
  expect((await fetch(`http://127.0.0.1:${worker!.port}/__scheduled`)).status).toBe(200)
  await expect.poll(() => sql("SELECT COUNT(*) AS n FROM inquiry_submissions WHERE id = 'abandoned'"), { timeout: 5000 }).toEqual([{ n: 0 }])
  expect(sql("SELECT COUNT(*) AS n FROM inquiry_files WHERE submission_id = 'abandoned'")).toEqual([{ n: 0 }])
  expect(sql("SELECT status FROM inquiry_submissions WHERE id = 'real'")).toEqual([{ status: 'submitted' }])
  expect(sql("SELECT COUNT(*) AS n FROM inquiry_files WHERE status = 'linked'")).toEqual([{ n: 1 }])
}, 60_000)
