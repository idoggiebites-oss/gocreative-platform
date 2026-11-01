// Conversion and deletion on workerd and real D1: last_insert_rowid across batch statements, the triggers and the unique index are the real thing here.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { unstable_dev } from 'wrangler'

const dir = mkdtempSync(join(tmpdir(), 'gocreative-convert-'))
const config = join(dir, 'wrangler.json')
let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined
const wrangler = (...args: string[]) => execFileSync('npx', ['wrangler', 'd1', ...args, '--local', '--persist-to', dir, '-c', config], { encoding: 'utf8', stdio: 'pipe' })
const sql = (command: string) => (JSON.parse(wrangler('execute', 'gocreative', '--json', '--command', command)) as { results: Record<string, unknown>[] }[])[0].results
const plant = (id: string) => {
  const token = id.padEnd(43, 'x')
  sql(`INSERT INTO inquiry_submissions (id, token_hash, ip_hash, expires_at) VALUES ('${id}', '${createHash('sha256').update(token).digest('hex')}', 'ip', '2999-01-01T00:00:00.000Z')`)
  return token
}

beforeAll(async () => {
  writeFileSync(config, JSON.stringify({
    name: 'gocreative-convert-test', main: resolve('worker/index.ts'), compatibility_date: '2026-10-01',
    d1_databases: [{ binding: 'DB', database_name: 'gocreative', database_id: 'local-test', migrations_dir: resolve('migrations') }],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'gocreative-files' }],
    vars: { IP_HASH_SALT: 'salt', DEV_TURNSTILE_PASS: '1', DEV_AUTH_EMAIL: 'owner1@example.com' },
  }))
  wrangler('migrations', 'apply', 'gocreative')
  wrangler('execute', 'gocreative', '--file', resolve('scripts/seed.sql'))
  sql("DELETE FROM settings WHERE key = 'intake_closed'")
  worker = await unstable_dev(resolve('worker/index.ts'), { config, persistTo: dir, ip: '127.0.0.1', port: 0, logLevel: 'none', experimental: { disableExperimentalWarning: true, disableDevRegistry: true, testScheduled: true } })
}, 120_000)
afterAll(async () => {
  await worker?.stop()
  rmSync(dir, { recursive: true, force: true })
})

const base = () => `http://127.0.0.1:${worker!.port}/api`
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const PDF = new TextEncoder().encode('%PDF-1.7 test')
const upload = (token: string, body: Uint8Array, type: string, purpose: string, name: string) => fetch(`${base()}/public/submissions/files`, { method: 'POST', body, headers: { Authorization: `Bearer ${token}`, 'Content-Type': type, 'X-File-Purpose': purpose, 'X-Filename': name, 'Content-Length': String(body.length) } })
const FORM = {
  customerKind: 'district', organization: 'Real ISD', contactName: 'Real Contact', contactEmail: 'real@example.com', dueDate: '2031-05-01', description: 'Placement: left chest.',
  lines: [{ product: 'tshirts', method: 'screen', quantity: 3, sizes: { M: 3 }, color: 'Navy' }, { product: 'polos', method: 'embroidery', quantity: 2, sizes: { L: 2 } }, { product: 'hats', method: 'help', quantity: 4 }],
}
const submit = (token: string) => fetch(`${base()}/public/submissions/submit`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(FORM) })
const convert = (id: unknown) => fetch(`${base()}/app/inquiries/${id}/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, title: 'Real order', dueDate: '2031-05-01', artworkRequired: true, customer: { new: { name: 'Real ISD', kind: 'district', organization: 'Real ISD' } } }) })

test('parallel conversions on real D1 make one order with every line, the new customer and contact, and the PO unverified', async () => {
  const token = plant('alpha')
  expect((await upload(token, PNG, 'image/png', 'artwork', 'logo.png')).status).toBe(201)
  expect((await upload(token, PDF, 'application/pdf', 'po', 'po.pdf')).status).toBe(201)
  expect((await submit(token)).status).toBe(201)
  const [{ id }] = sql("SELECT id FROM inquiries WHERE submission_id = 'alpha'")
  const before = sql('SELECT (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM customers) c')[0]
  const replies = await Promise.all([convert(id), convert(id), convert(id), convert(id)])
  const bodies = await Promise.all(replies.map((r) => r.json() as Promise<{ number: string }>))
  expect(new Set(bodies.map((b) => b.number)).size).toBe(1)
  const after = sql('SELECT (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM customers) c')[0]
  expect(after).toEqual({ o: Number(before.o) + 1, c: Number(before.c) + 1 })
  const number = bodies[0].number
  expect(sql(`SELECT i.product, i.method, i.quantity FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.number = '${number}' ORDER BY i.id`)).toEqual([
    { product: 'T-shirts', method: 'screen', quantity: 3 }, { product: 'Polos', method: 'embroidery', quantity: 2 }, { product: 'Hats', method: 'other', quantity: 4 },
  ])
  expect(sql(`SELECT c.name AS customer, k.name AS contact, o.source, o.po_required FROM orders o JOIN customers c ON c.id = o.customer_id JOIN customer_contacts k ON k.id = o.contact_id AND k.customer_id = c.id WHERE o.number = '${number}'`))
    .toEqual([{ customer: 'Real ISD', contact: 'Real Contact', source: 'portal', po_required: 1 }])
  expect(sql(`SELECT p.status, d.file_id IS NOT NULL AS has_doc, f.filename FROM purchase_orders p JOIN orders o ON o.id = p.order_id JOIN po_documents d ON d.po_id = p.id JOIN files f ON f.id = d.file_id WHERE o.number = '${number}'`))
    .toEqual([{ status: 'received', has_doc: 1, filename: 'po.pdf' }])
  expect(sql(`SELECT a.approval_status, f.filename FROM artwork a JOIN orders o ON o.id = a.order_id JOIN files f ON f.id = a.file_id WHERE o.number = '${number}'`)).toEqual([{ approval_status: 'under_review', filename: 'logo.png' }])
  expect(sql('PRAGMA foreign_key_check')).toEqual([])
  // The staff file route serves it, and the unique index refuses a second order on this inquiry at the database.
  const file = sql(`SELECT i.file_id AS id FROM inquiry_files i WHERE i.submission_id = 'alpha' AND i.kind = 'po'`)[0]
  expect((await fetch(`${base()}/app/files/${file.id}`)).status).toBe(200)
  expect(() => sql(`UPDATE inquiries SET status = 'new' WHERE id = ${id}`)).toThrow()
}, 90_000)

test('real owner delete and the real cron: journal, objects and rows go, a converted inquiry stays', async () => {
  const token = plant('bravo')
  expect((await upload(token, PNG, 'image/png', 'artwork', 'gone.png')).status).toBe(201)
  expect((await submit(token)).status).toBe(201)
  const [{ id }] = sql("SELECT id FROM inquiries WHERE submission_id = 'bravo'")
  const del = await fetch(`${base()}/app/inquiries/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1 }) })
  expect(del.status).toBe(200)
  expect(sql(`SELECT id FROM inquiries WHERE id = ${id}`)).toEqual([])
  expect(sql("SELECT id FROM inquiry_files WHERE submission_id = 'bravo'")).toEqual([])
  expect(sql("SELECT id FROM inquiry_submissions WHERE id = 'bravo'")).toEqual([])
  expect(sql(`SELECT after FROM activity_log WHERE entity_type = 'inquiry' AND entity_id = ${id} AND action = 'inquiry_deleted'`)).toEqual([{ after: '{"reason":"owner","files":1}' }])

  const token2 = plant('charlie')
  expect((await submit(token2)).status).toBe(201)
  sql(`DROP TRIGGER inquiries_identity_fixed; UPDATE inquiries SET status = 'spam', created_at = '2000-01-01T00:00:00.000Z' WHERE submission_id = 'charlie'`)
  expect((await fetch(`http://127.0.0.1:${worker!.port}/__scheduled`)).status).toBe(200)
  await expect.poll(() => sql("SELECT id FROM inquiries WHERE submission_id = 'charlie'"), { timeout: 8000 }).toEqual([])
  expect(sql("SELECT status FROM inquiries WHERE submission_id = 'alpha'")).toEqual([{ status: 'converted' }])
  expect(sql('PRAGMA foreign_key_check')).toEqual([])
}, 90_000)

test('pricing on real D1: parallel publishes leave one active version; estimates are append-only', async () => {
  const actor = sql("SELECT id FROM users LIMIT 1")[0].id
  sql(`INSERT INTO pricing_versions (config, config_hash, created_by) VALUES ('{}', 'h1', ${actor})`)
  const [{ id }] = sql("SELECT id FROM pricing_versions WHERE status = 'draft'")
  sql(`UPDATE pricing_versions SET status = 'active', published_by = ${actor}, published_at = '2026-01-01' WHERE id = ${id}`)
  expect(() => sql(`UPDATE pricing_versions SET config = '{"x":1}' WHERE id = ${id}`)).toThrow()
  expect(() => sql(`INSERT INTO pricing_versions (status, config, config_hash, created_by, published_by, published_at) VALUES ('active', '{}', 'h2', ${actor}, ${actor}, '2026-01-02')`)).toThrow()
  const [{ id: inq }] = sql("SELECT id FROM inquiries WHERE submission_id = 'alpha'")
  sql(`INSERT INTO inquiry_estimates (inquiry_id, engine_version, status, facts_source, inputs, customer_result, internal_result) VALUES (${inq}, 1, 'manual_review_required', 'none', '{}', '{}', '{}')`)
  expect(() => sql("UPDATE inquiry_estimates SET status = 'available'")).toThrow()
  expect(() => sql('DELETE FROM inquiry_estimates')).toThrow()
  expect(sql('PRAGMA foreign_key_check')).toEqual([])
}, 60_000)
