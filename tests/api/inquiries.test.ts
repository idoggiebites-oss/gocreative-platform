// Inquiry review and conversion over the real routes. The point of the suite: every line and file arrives, a customer's PO stays
// unverified, a repeat changes nothing, and Phase 2's rules apply to the result like any other order.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { checksum, dumpTable, foreignKeyOrder, listTables, replaySql, restoreSql, type Exec, type Row } from '../../scripts/backup-lib.ts'
import { cleanupIntake } from '../../worker/cron'
import { app } from '../../worker/index'
import { createTestD1 } from './d1'
import { PDF, PNG, createTestR2 } from './r2'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
const HOST = 'localhost'
const FORM = {
  customerKind: 'district', organization: 'Valley ISD', contactName: 'Rosa Medrano', contactEmail: 'rosa.new@example.com', contactPhone: '555-010-7788', dueDate: '2031-05-01', designHelp: true,
  description: 'Left chest logo.\nSpring banquet.',
  lines: [
    { product: 'tshirts', method: 'screen', quantity: 34, sizes: { M: 20, L: 14 }, color: 'Navy' },
    { product: 'tshirts', method: 'dtg', quantity: 5, sizes: { S: 5 }, color: 'White' },
    { product: 'hats', method: 'embroidery', quantity: 12 },
    { product: 'trophies', method: 'laser_engrave', quantity: 6, personalization: 'Names to follow' },
    { product: 'engraved', method: 'help', quantity: 3, material: 'Tumblers' },
  ],
}

function setup(email = 'owner1@example.com') {
  const { db, sqlite } = createTestD1()
  sqlite.exec(seed)
  sqlite.exec("DELETE FROM settings WHERE key = 'intake_closed'")
  const r2 = createTestR2()
  const env = { DB: db, FILES: r2.bucket, IP_HASH_SALT: 'salt', DEV_TURNSTILE_PASS: '1', DEV_AUTH_EMAIL: email } as unknown as Env
  const pub = (path: string, init: RequestInit = {}, ip = '203.0.113.1') => app.request(`http://${HOST}/api/public${path}`, { ...init, headers: { 'CF-Connecting-IP': ip, ...init.headers } }, env)
  const staff = (method: string, path: string, body?: unknown, as: string = email) => app.request(`http://${HOST}/api/app${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { ...env, DEV_AUTH_EMAIL: as } as Env)
  const submit = async (form: unknown = FORM, files: { bytes: Uint8Array; type: string; purpose: string; name: string }[] = [], ip = '203.0.113.1') => {
    const { token } = await (await pub('/submissions', { method: 'POST', body: '{}' }, ip)).json() as { token: string }
    for (const f of files) {
      const r = await pub('/submissions/files', { method: 'POST', body: f.bytes as Uint8Array<ArrayBuffer>, headers: { Authorization: `Bearer ${token}`, 'Content-Type': f.type, 'X-File-Purpose': f.purpose, 'X-Filename': f.name, 'Content-Length': String(f.bytes.byteLength) } }, ip)
      expect(r.status).toBe(201)
    }
    const res = await pub('/submissions/submit', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(form) }, ip)
    expect(res.status).toBe(201)
    const { ref } = await res.json() as { ref: string }
    return { ref, id: (sqlite.prepare('SELECT id FROM inquiries WHERE ref = ?').get(ref) as { id: number }).id }
  }
  const n = (sql: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n
  const detail = async (id: number) => (await staff('GET', `/inquiries/${id}`)).json() as Promise<Record<string, never> & { version: number; lines: unknown[]; files: { id: number; kind: string }[]; matches: { id: number; contacts: { id: number }[] }[]; status: string; orderNumber: string | null; description: string }>
  const convert = (id: number, version: number, extra: object = {}) => staff('POST', `/inquiries/${id}/convert`, {
    expectedVersion: version, title: 'Valley spring order', dueDate: '2031-05-01', artworkRequired: true, customer: { new: { name: 'Valley ISD', kind: 'district', organization: 'Valley ISD' } }, ...extra,
  })
  return { sqlite, db, r2, env, pub, staff, submit, n, detail, convert }
}
const ART = { bytes: PNG, type: 'image/png', purpose: 'artwork', name: 'logo.png' }
const PO = { bytes: PDF, type: 'application/pdf', purpose: 'po', name: 'po-4471.pdf' }

let time: ReturnType<typeof vi.spyOn> | undefined
beforeEach(() => { time = undefined })
afterEach(() => time?.mockRestore())

test('every line transfers completely and accurately: product, method, sizes, quantity, color and details, in order', async () => {
  const t = setup()
  const { id } = await t.submit(FORM, [ART])
  const res = await t.convert(id, 1)
  expect(res.status).toBe(201)
  const { number } = await res.json() as { number: string }
  const order = t.sqlite.prepare('SELECT id, source, due_date, title, production_status FROM orders WHERE number = ?').get(number) as { id: number; source: string; due_date: string; title: string }
  expect(order).toMatchObject({ source: 'portal', due_date: '2031-05-01', title: 'Valley spring order' })
  const items = t.sqlite.prepare('SELECT kind, product, method, quantity, sizes, garment_color, description, notes, unit_price_cents FROM order_items WHERE order_id = ? ORDER BY id').all(order.id) as Row[]
  expect(items).toEqual([
    { kind: 'product', product: 'T-shirts', method: 'screen', quantity: 34, sizes: '{"M":20,"L":14}', garment_color: 'Navy', description: null, notes: null, unit_price_cents: 0 },
    { kind: 'product', product: 'T-shirts', method: 'dtg', quantity: 5, sizes: '{"S":5}', garment_color: 'White', description: null, notes: null, unit_price_cents: 0 },
    { kind: 'product', product: 'Hats', method: 'embroidery', quantity: 12, sizes: null, garment_color: null, description: null, notes: null, unit_price_cents: 0 },
    { kind: 'product', product: 'Trophies and awards', method: 'laser_engrave', quantity: 6, sizes: null, garment_color: null, description: 'Personalization: Names to follow', notes: null, unit_price_cents: 0 },
    { kind: 'product', product: 'Engraved or cut items', method: 'other', quantity: 3, sizes: null, garment_color: null, description: 'Material or item: Tumblers', notes: 'Customer asked for help choosing the method.', unit_price_cents: 0 },
  ])
  expect((t.sqlite.prepare("SELECT body FROM notes WHERE entity_type = 'order' AND entity_id = ?").get(order.id) as { body: string }).body).toContain('Left chest logo.\nSpring banquet.')
  // The original is kept exactly as sent.
  const kept = t.sqlite.prepare('SELECT payload, status FROM inquiries WHERE id = ?').get(id) as { payload: string; status: string }
  expect(kept.status).toBe('converted')
  expect(JSON.parse(kept.payload).lines).toHaveLength(5)
  expect(() => t.sqlite.exec(`UPDATE inquiries SET payload = '{}' WHERE id = ${id}`)).toThrow(/frozen/)
})

test('a new customer and contact are created from the request, and the order uses them', async () => {
  const t = setup()
  const { id } = await t.submit()
  const { number } = await (await t.convert(id, 1)).json() as { number: string }
  const row = t.sqlite.prepare(`SELECT c.name, c.kind, c.email, k.name AS contact, k.email AS contact_email, k.phone, k.is_primary, c.default_po_required, c.default_payment_terms, o.po_required, o.payment_terms
    FROM orders o JOIN customers c ON c.id = o.customer_id JOIN customer_contacts k ON k.id = o.contact_id WHERE o.number = ?`).get(number)
  expect(row).toEqual({ name: 'Valley ISD', kind: 'district', email: 'rosa.new@example.com', contact: 'Rosa Medrano', contact_email: 'rosa.new@example.com', phone: '555-010-7788', is_primary: 1, default_po_required: 1, default_payment_terms: 'due_after_pickup', po_required: 1, payment_terms: 'due_after_pickup' })
})

test('a customer who sent a PO is never verified by it: status received, unverified, and the gate still refuses', async () => {
  const t = setup()
  const { id } = await t.submit(FORM, [ART, PO])
  const { number } = await (await t.convert(id, 1)).json() as { number: string }
  const order = t.sqlite.prepare('SELECT id, po_required FROM orders WHERE number = ?').get(number) as { id: number; po_required: number }
  expect(order.po_required).toBe(1)
  expect(t.sqlite.prepare('SELECT status, po_number, amount_cents FROM purchase_orders WHERE order_id = ?').all(order.id)).toEqual([{ status: 'received', po_number: null, amount_cents: null }])
  expect(t.n(`po_documents d JOIN purchase_orders p ON p.id = d.po_id WHERE p.order_id = ${order.id}`)).toBe(1)
  const art = t.sqlite.prepare('SELECT approval_status, approved_at, approved_via, design_name, version FROM artwork WHERE order_id = ?').all(order.id)
  expect(art).toEqual([{ approval_status: 'under_review', approved_at: null, approved_via: null, design_name: 'logo.png', version: 1 }])
  const d = await (await t.staff('GET', `/orders/${number}`)).json() as { readiness: { items: { key: string; state: string }[] } }
  const states = Object.fromEntries(d.readiness.items.map((i) => [i.key, i.state]))
  expect(states).toMatchObject({ quote: 'pending', artwork: 'pending' })
  expect(Object.entries(states).find(([k]) => /auth|po/i.test(k))?.[1]).toBe('pending')
  const start = await t.staff('PATCH', `/orders/${number}/production`, { to: 'in_production', expectedVersion: 0 })
  expect(start.status).toBeGreaterThanOrEqual(400)
  // Only the normal staff workflow can approve it. A PO the customer attached is opened by staff like any other.
  const { purchaseOrders } = await (await t.staff('GET', `/orders/${number}/purchase-orders`)).json() as { purchaseOrders: { id: number; status: string; documents: { id: number }[] }[] }
  expect(purchaseOrders[0].status).toBe('received')
  expect(purchaseOrders[0].documents).toHaveLength(1)
})

test('a conversion cannot be told to mark anything approved, whatever the request says', async () => {
  const t = setup()
  const { id } = await t.submit(FORM, [PO])
  for (const extra of [{ poStatus: 'approved' }, { items: [] }, { status: 'approved' }, { customer: { new: { name: 'x', kind: 'district', organization: null, defaultPaymentTerms: 'due_after_pickup' } } }]) {
    expect((await t.convert(id, 1, extra)).status, JSON.stringify(extra)).toBe(400)
  }
  expect(t.n('inquiries WHERE status = \'converted\'')).toBe(0)
})

test('idempotent and race-safe: a repeat, parallel requests and a stale version make exactly one order and one number', async () => {
  const t = setup()
  const { id } = await t.submit(FORM, [ART, PO])
  const orders = t.n('orders')
  const customers = t.n('customers')
  const counter = () => (t.sqlite.prepare("SELECT next FROM counters WHERE name = 'order' ORDER BY year DESC LIMIT 1").get() as { next: number } | undefined)?.next
  const before = counter()
  const replies = await Promise.all([t.convert(id, 1), t.convert(id, 1), t.convert(id, 1)])
  const numbers = new Set(await Promise.all(replies.map(async (r) => ((await r.json()) as { number: string }).number)))
  expect(numbers.size).toBe(1)
  expect(replies.filter((r) => r.status === 201)).toHaveLength(1)
  expect(t.n('orders')).toBe(orders + 1)
  expect(t.n('customers')).toBe(customers + 1)
  expect(counter()).toBe((before ?? 1) + 1)
  expect(t.n("activity_log WHERE action = 'inquiry_converted'")).toBe(1)
  // Afterwards, with the old version: the same answer.
  const again = await t.convert(id, 1)
  expect(again.status).toBe(200)
  expect(await again.json()).toEqual({ number: [...numbers][0], alreadyConverted: true })
  expect(t.n('artwork')).toBeGreaterThan(0)
  expect(t.n(`purchase_orders WHERE status = 'received' AND order_id = (SELECT order_id FROM inquiries WHERE id = ${id})`)).toBe(1)
})

test('a stale version or a contact that moved writes nothing at all, and burns no number', async () => {
  const t = setup()
  const { id } = await t.submit()
  const counts = () => [t.n('orders'), t.n('customers'), t.n('customer_contacts'), t.n('order_items')]
  const before = counts()
  expect((await t.convert(id, 99)).status).toBe(409)
  expect(counts()).toEqual(before)
  const other = t.sqlite.prepare('SELECT id FROM customers ORDER BY id LIMIT 2').all() as { id: number }[]
  const foreign = (t.sqlite.prepare('SELECT id FROM customer_contacts WHERE customer_id <> ? LIMIT 1').get(other[0].id) as { id: number } | undefined)?.id
  expect(foreign).toBeTruthy()
  const res = await t.convert(id, 1, { customer: { existingId: other[0].id, contactId: foreign } })
  expect(res.status).toBe(400)
  expect(counts()).toEqual(before)
  expect(t.n(`inquiries WHERE id = ${id} AND status = 'new'`)).toBe(1)
  expect(t.sqlite.prepare('SELECT converted_customer_id AS a, converted_contact_id AS b, version FROM inquiries WHERE id = ?').get(id)).toEqual({ a: null, b: null, version: 1 }) // not one column
  expect((await t.convert(id, 1, { customer: { existingId: 999999, contactId: null } })).status).toBe(404)
})

test('an existing customer is matched by email or phone, only suggested, and keeps its own defaults', async () => {
  const t = setup()
  const existing = t.sqlite.prepare('SELECT id, name, default_po_required, default_payment_terms FROM customers LIMIT 1').get() as { id: number; default_po_required: number; default_payment_terms: string }
  t.sqlite.exec(`INSERT INTO customer_contacts (customer_id, name, email, phone) VALUES (${existing.id}, 'Known Person', 'KNOWN@example.com', '(555) 010-9911')`)
  const { id } = await t.submit({ ...FORM, contactEmail: 'known@example.com', contactPhone: undefined })
  const d = await t.detail(id)
  expect(d.matches.map((m) => m.id)).toEqual([existing.id])
  const byPhone = await t.submit({ ...FORM, contactEmail: undefined, contactPhone: '555-010-9911' }, [], '203.0.113.2')
  expect((await t.detail(byPhone.id)).matches.map((m) => m.id)).toEqual([existing.id])
  const contactId = d.matches[0].contacts.find((c) => 'email' in c && (c as { email: string }).email === 'KNOWN@example.com')!.id
  const customers = t.n('customers')
  const { number } = await (await t.convert(id, 1, { customer: { existingId: existing.id, contactId } })).json() as { number: string }
  expect(t.n('customers')).toBe(customers)
  expect(t.sqlite.prepare('SELECT customer_id, contact_id, payment_terms FROM orders WHERE number = ?').get(number)).toEqual({ customer_id: existing.id, contact_id: contactId, payment_terms: existing.default_payment_terms })
})

test('long personalization stays whole in the note, and the item it came from can still be priced with the ordinary editor', async () => {
  const t = setup()
  const names = Array.from({ length: 60 }, (_, i) => `Player number ${i}`).join(', ')
  expect(names.length).toBeGreaterThan(600)
  const { id } = await t.submit({ ...FORM, description: undefined, lines: [{ product: 'trophies', method: 'laser_engrave', quantity: 60, personalization: names }] })
  const { number } = await (await t.convert(id, 1)).json() as { number: string }
  const o = t.sqlite.prepare('SELECT id, version FROM orders WHERE number = ?').get(number) as { id: number; version: number }
  expect((t.sqlite.prepare("SELECT body FROM notes WHERE entity_type = 'order' AND entity_id = ?").get(o.id) as { body: string }).body).toContain(names)
  const d = await (await t.staff('GET', `/orders/${number}`)).json() as { items: Record<string, unknown>[] }
  const edit = await t.staff('PUT', `/orders/${number}/items`, { expectedVersion: o.version, items: d.items.map((i) => ({ id: i.id, kind: i.kind, description: i.description, product: i.product, garmentColor: i.garmentColor, method: i.method, sizes: i.sizes, quantity: i.quantity, unitPriceCents: 1250, notes: i.notes ?? null })) })
  expect(edit.status, await edit.clone().text()).toBe(200)
  expect((t.sqlite.prepare('SELECT unit_price_cents AS p FROM order_items WHERE order_id = ?').get(o.id) as { p: number }).p).toBe(1250)
})

test('two overlapping deletions: the journal keeps the first, full entry, and one audit row is written', async () => {
  const t = setup()
  const { id } = await t.submit(FORM, [ART, PO])
  const { processClaimed } = await import('../../worker/inquiryDeletion')
  t.sqlite.exec(`UPDATE inquiries SET deleting_at = '2030-01-01T00:00:00.000Z' WHERE id = ${id}`)
  const { listClaimed, removeClaimedRows } = await import('../../worker/db/inquiries')
  const stale = (await listClaimed(t.db as never, 10))[0] // the second run already read its claim
  await processClaimed(t.env, 'owner', 1)
  const key = [...t.r2.objects.keys()].find((k) => k.startsWith('_journal/'))!
  const first = new TextDecoder().decode(t.r2.objects.get(key)!.bytes)
  expect(JSON.parse(first).files).toHaveLength(2)
  await t.r2.bucket.put(key, JSON.stringify({ files: [] }), { onlyIf: { etagDoesNotMatch: '*' } } as never)
  expect(new TextDecoder().decode(t.r2.objects.get(key)!.bytes)).toBe(first)
  await removeClaimedRows(t.db as never, stale, [], 'retention', null)
  expect(t.n("activity_log WHERE action = 'inquiry_deleted'")).toBe(1)
})

test('the converted order follows the normal Phase 2 workflow: quote and PO approval', async () => {
  const t = setup()
  const { id } = await t.submit(FORM, [PO])
  const { number } = await (await t.convert(id, 1)).json() as { number: string }
  const v = async () => (t.sqlite.prepare('SELECT version FROM orders WHERE number = ?').get(number) as { version: number }).version
  const { purchaseOrders } = await (await t.staff('GET', `/orders/${number}/purchase-orders`)).json() as { purchaseOrders: { id: number }[] }
  const move = (to: string) => v().then((expectedVersion) => t.staff('PATCH', `/orders/${number}/purchase-orders/${purchaseOrders[0].id}`, { to, expectedVersion }))
  expect((await move('under_review')).status).toBe(200)
  expect((await move('approved')).status).toBe(200)
  const quote = await t.staff('POST', `/orders/${number}/quotes`, { expectedVersion: await v() })
  expect(quote.status).toBeLessThan(300)
})

test('spam, decline with an internal reason, and back to new: versioned, and never for a converted inquiry', async () => {
  const t = setup()
  const { id } = await t.submit()
  const set = (body: object) => t.staff('POST', `/inquiries/${id}/status`, body)
  expect((await set({ to: 'declined', reason: 'Out of scope', expectedVersion: 5 })).status).toBe(409)
  expect((await set({ to: 'declined', reason: 'Out of scope', expectedVersion: 1 })).status).toBe(200)
  expect(t.sqlite.prepare('SELECT status, decline_reason FROM inquiries WHERE id = ?').get(id)).toEqual({ status: 'declined', decline_reason: 'Out of scope' })
  expect((await t.convert(id, 2)).status).toBe(409) // not new
  expect((await set({ to: 'new', expectedVersion: 2 })).status).toBe(200)
  expect(t.sqlite.prepare('SELECT decline_reason FROM inquiries WHERE id = ?').get(id)).toEqual({ decline_reason: null })
  expect((await t.convert(id, 3)).status).toBe(201)
  expect((await set({ to: 'spam', expectedVersion: 4 })).status).toBe(409)
  expect(JSON.stringify(await (await t.pub('/status')).json())).not.toContain('Out of scope')
})

test('authorization: every route needs a signed-in staff member; deleting needs an owner', async () => {
  const t = setup()
  const { id } = await t.submit()
  const noAuth = { ...t.env, DEV_AUTH_EMAIL: undefined, ACCESS_AUD: 'a', ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com' } as unknown as Env
  for (const [method, path] of [['GET', `/inquiries/${id}`], ['POST', `/inquiries/${id}/convert`], ['POST', `/inquiries/${id}/status`], ['DELETE', `/inquiries/${id}`]]) {
    expect((await app.request(`https://gocreative.test/api/app${path}`, { method, body: method === 'GET' ? undefined : '{}' }, noAuth)).status, path).toBe(401)
  }
  expect((await t.pub(`/inquiries/${id}`)).status).toBe(404) // not on the public router at all
  t.sqlite.exec("INSERT INTO users (email, name, role, active) VALUES ('staff9@example.com', 'Staff', 'staff', 1)")
  const staffEmail = 'staff9@example.com'
  expect((await t.staff('DELETE', `/inquiries/${id}`, { expectedVersion: 1 }, staffEmail)).status).toBe(403)
  expect((await t.staff('POST', `/inquiries/${id}/convert`, { expectedVersion: 1, title: 'x', dueDate: null, artworkRequired: true, customer: { new: { name: 'S', kind: 'individual', organization: null } } }, staffEmail)).status).toBe(201)
  expect(t.n(`inquiries WHERE id = ${id} AND status = 'converted'`)).toBe(1)
})

test('owner delete: journal first, then objects, then rows; no personal data in the journal or audit; never a converted inquiry', async () => {
  const t = setup()
  const { id } = await t.submit(FORM, [ART, PO])
  const keys = (t.sqlite.prepare('SELECT r2_key FROM inquiry_files WHERE inquiry_id = ?').all(id) as { r2_key: string }[]).map((r) => r.r2_key)
  const order: string[] = []
  const { put, delete: del } = t.r2.bucket
  t.r2.bucket.put = ((k: string, v: never, o: never) => { order.push(`put ${k.split('/')[0]}`); return put(k, v, o) }) as never
  t.r2.bucket.delete = ((k: string[]) => { order.push('delete objects'); return del(k) }) as never
  expect((await t.staff('DELETE', `/inquiries/${id}`, { expectedVersion: 1 })).status).toBe(200)
  expect(order).toEqual(['put _journal', 'delete objects'])
  expect(t.n(`inquiries WHERE id = ${id}`)).toBe(0)
  expect(t.n("files WHERE r2_key LIKE 'inquiries/%'")).toBe(0)
  expect(t.n('inquiry_files')).toBe(0)
  for (const k of keys) expect(t.r2.objects.has(k)).toBe(false)
  const journal = [...t.r2.objects.entries()].filter(([k]) => k.startsWith('_journal/'))
  expect(journal).toHaveLength(1)
  const text = new TextDecoder().decode(journal[0][1].bytes)
  for (const pii of ['Rosa', 'rosa.new', '555-010', 'Valley', 'Left chest', 'logo.png']) expect(text).not.toContain(pii)
  expect(JSON.parse(text)).toMatchObject({ inquiryId: id, reason: 'owner' })
  const audit = t.sqlite.prepare("SELECT after FROM activity_log WHERE entity_type = 'inquiry' AND action = 'inquiry_deleted'").get() as { after: string }
  expect(audit.after).toBe('{"reason":"owner","files":2}')

  const kept = await t.submit(FORM, [], '203.0.113.5')
  await t.convert(kept.id, 1)
  expect((await t.staff('DELETE', `/inquiries/${kept.id}`, { expectedVersion: 2 })).status).toBe(409)
  expect(() => t.sqlite.exec(`DELETE FROM inquiries WHERE id = ${kept.id}`)).toThrow(/claimed_only/)
})

test('a request with failed and removed upload attempts deletes cleanly, live and on replay', async () => {
  const t = setup()
  const { id } = await t.submit(FORM, [ART])
  const sid = (t.sqlite.prepare('SELECT submission_id AS s FROM inquiries WHERE id = ?').get(id) as { s: string }).s
  t.sqlite.exec(`INSERT INTO inquiry_files (id, submission_id, r2_key, kind, status, bytes) VALUES ('tried', '${sid}', 'inquiries/${sid}/tried', 'artwork', 'failed', 5), ('stuck', '${sid}', 'inquiries/${sid}/stuck', 'artwork', 'deleting', 5)`)
  await t.r2.bucket.put(`inquiries/${sid}/stuck`, PNG)
  const exec: Exec = (sql) => t.sqlite.prepare(sql).all() as Row[]
  const order = await foreignKeyOrder(exec, await listTables(exec))
  const snapshot = await Promise.all(order.map(async (name) => ({ name, rows: await dumpTable(exec, name) })))

  expect((await t.staff('DELETE', `/inquiries/${id}`, { expectedVersion: 1 })).status).toBe(200)
  expect(t.n(`inquiries WHERE id = ${id}`)).toBe(0)
  expect(t.n(`inquiry_files WHERE submission_id = '${sid}'`)).toBe(0)
  expect(t.n(`inquiry_submissions WHERE id = '${sid}'`)).toBe(0)
  expect(t.r2.objects.has(`inquiries/${sid}/stuck`)).toBe(false)
  const entry = JSON.parse(new TextDecoder().decode([...t.r2.objects.entries()].find(([k]) => k.startsWith('_journal/'))![1].bytes))

  const target = createTestD1()
  const texec: Exec = (sql) => target.sqlite.prepare(sql).all() as Row[]
  const triggers = texec("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name") as { name: string; sql: string }[]
  target.sqlite.exec('BEGIN'); target.sqlite.exec(restoreSql(snapshot, triggers)); target.sqlite.exec('COMMIT')
  target.sqlite.exec('BEGIN'); target.sqlite.exec(replaySql([entry], triggers)); target.sqlite.exec('COMMIT')
  expect(texec(`SELECT id FROM inquiries WHERE id = ${id}`)).toEqual([])
  expect(texec(`SELECT id FROM inquiry_files WHERE submission_id = '${sid}'`)).toEqual([])
  expect(texec('PRAGMA foreign_key_check')).toEqual([])
})

test('a failed delete keeps the claim and finishes on the next run; a claimed inquiry cannot be converted', async () => {
  const t = setup()
  const { id } = await t.submit(FORM, [ART])
  const del = t.r2.bucket.delete
  t.r2.bucket.delete = (async () => { throw new Error('R2 down') }) as never
  expect((await t.staff('DELETE', `/inquiries/${id}`, { expectedVersion: 1 })).status).toBe(200)
  t.r2.bucket.delete = del
  expect(t.n(`inquiries WHERE id = ${id} AND deleting_at IS NOT NULL`)).toBe(1)
  expect(t.n("files WHERE r2_key LIKE 'inquiries/%'")).toBe(1) // the row still names the object
  expect((await t.staff('GET', `/inquiries/${id}`)).status).toBe(404) // out of the queue
  expect((await t.convert(id, 1)).status).toBe(404)
  expect(((await cleanupIntake(t.env, new Date())) as { inquiriesDeleted: number }).inquiriesDeleted).toBe(1)
  expect(t.n(`inquiries WHERE id = ${id}`)).toBe(0)
  expect([...t.r2.objects.keys()].filter((k) => k.startsWith('_journal/'))).toHaveLength(1) // a retry adds no second entry
  expect([...t.r2.objects.keys()].filter((k) => k.startsWith('inquiries/'))).toEqual([])
})

test('retention: spam from receipt after 30 days, unconverted after 12 months, converted never; reclassifying cannot extend it', async () => {
  const t = setup()
  const age = (id: number, modifier: string) => t.sqlite.exec(`DROP TRIGGER IF EXISTS inquiries_identity_fixed; UPDATE inquiries SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','${modifier}') WHERE id = ${id}`)
  const spamOld = await t.submit(FORM, [], '203.0.113.11')
  const spamNew = await t.submit(FORM, [], '203.0.113.12')
  const newOld = await t.submit(FORM, [ART], '203.0.113.13')
  const newYoung = await t.submit(FORM, [], '203.0.113.14')
  const converted = await t.submit(FORM, [ART], '203.0.113.15')
  const set = (id: number, to: string) => t.staff('POST', `/inquiries/${id}/status`, { to, expectedVersion: 1 })
  await set(spamOld.id, 'spam'); await set(spamNew.id, 'spam')
  await t.convert(converted.id, 1)
  age(spamOld.id, '-31 days'); age(spamNew.id, '-29 days'); age(newOld.id, '-13 months'); age(newYoung.id, '-11 months')
  t.sqlite.exec(`DROP TRIGGER inquiries_converted_frozen; UPDATE inquiries SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ${converted.id}`)
  expect(((await cleanupIntake(t.env, new Date())) as { inquiriesDeleted: number }).inquiriesDeleted).toBe(2)
  const left = (t.sqlite.prepare('SELECT id FROM inquiries').all() as { id: number }[]).map((r) => r.id).sort()
  expect(left).toEqual([spamNew.id, newYoung.id, converted.id].sort())
  expect(t.n(`artwork WHERE order_id = (SELECT order_id FROM inquiries WHERE id = ${converted.id})`)).toBe(1) // its files stayed
})

test('the storage cap: a converted file stops counting, an unconverted one counts until it is really gone', async () => {
  const t = setup()
  const { id } = await t.submit(FORM, [ART])
  const OUT = "SELECT COALESCE(SUM(bytes),0) AS b FROM inquiry_files WHERE status = 'linked' AND NOT EXISTS (SELECT 1 FROM inquiries i WHERE i.id = inquiry_id AND i.status = 'converted')"
  expect((t.sqlite.prepare(OUT).get() as { b: number }).b).toBe(PNG.byteLength)
  await t.convert(id, 1)
  expect((t.sqlite.prepare(OUT).get() as { b: number }).b).toBe(0)
})

test('a backup with conversions restores exactly, and a deletion after the backup stays deleted when replayed', async () => {
  const t = setup()
  const gone = await t.submit(FORM, [ART], '203.0.113.21')
  const stays = await t.submit(FORM, [ART, PO], '203.0.113.22')
  await t.convert(stays.id, 1)
  const exec: Exec = (sql) => t.sqlite.prepare(sql).all() as Row[]
  const order = await foreignKeyOrder(exec, await listTables(exec)) // would throw on a foreign key cycle
  const tables = await Promise.all(order.map(async (name) => ({ name, rows: await dumpTable(exec, name) })))
  const target = createTestD1()
  const texec: Exec = (sql) => target.sqlite.prepare(sql).all() as Row[]
  const triggers = texec("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name") as { name: string; sql: string }[]
  target.sqlite.exec('BEGIN'); target.sqlite.exec(restoreSql(tables, triggers)); target.sqlite.exec('COMMIT')
  for (const x of tables) expect(checksum(await dumpTable(texec, x.name)), x.name).toBe(checksum(x.rows))
  expect(texec('PRAGMA foreign_key_check')).toEqual([])

  const files = t.sqlite.prepare('SELECT i.file_id AS fileId, i.r2_key AS r2Key, f.sha256 FROM inquiry_files i JOIN files f ON f.id = i.file_id WHERE i.inquiry_id = ?').all(gone.id) as { fileId: number; r2Key: string; sha256: string }[]
  const sid = (t.sqlite.prepare('SELECT submission_id AS s FROM inquiries WHERE id = ?').get(gone.id) as { s: string }).s
  target.sqlite.exec('BEGIN')
  target.sqlite.exec(replaySql([{ kind: 'inquiry', inquiryId: gone.id, submissionId: sid, at: '2999-01-01', reason: 'owner', files }], triggers))
  target.sqlite.exec('COMMIT')
  expect(texec(`SELECT id FROM inquiries WHERE id = ${gone.id}`)).toEqual([])
  expect(texec(`SELECT id FROM files WHERE id = ${files[0].fileId}`)).toEqual([])
  expect(texec(`SELECT status FROM inquiries WHERE id = ${stays.id}`)).toEqual([{ status: 'converted' }])
  expect(texec('PRAGMA foreign_key_check')).toEqual([])
  expect(texec("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name")).toEqual(triggers)
})
