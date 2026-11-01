// The order writes rely on three properties of D1's batch() that tests/api (node:sqlite behind a D1-shaped
// adapter) can only assume: statements run in order, changes() in statement N reflects statement N-1, and a
// failing statement rolls the whole batch back. This proves them on the real workerd D1 (wrangler's
// getPlatformProxy, local binding, migrations + seed applied to a throwaway persist dir), then runs the real
// db/orders.ts write paths against it. Part of `npm test` (about 3 s).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPlatformProxy } from 'wrangler'
import * as dbo from '../../worker/db/orders'

const dir = mkdtempSync(join(tmpdir(), 'gocreative-d1-'))
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database; FILES: R2Bucket }>>>
let db: D1Database

beforeAll(async () => {
  const wrangler = (...args: string[]) => execFileSync('npx', ['wrangler', 'd1', ...args, '--local', '--persist-to', dir], { stdio: 'pipe' })
  wrangler('migrations', 'apply', 'gocreative')
  wrangler('execute', 'gocreative', '--file', 'scripts/seed.sql')
  // --persist-to <dir> stores under <dir>/v3, which is the path getPlatformProxy takes.
  proxy = await getPlatformProxy<{ DB: D1Database; FILES: R2Bucket }>({ persist: { path: join(dir, 'v3') }, remoteBindings: false })
  db = proxy.env.DB
  await db.exec('CREATE TABLE scratch (id INTEGER PRIMARY KEY, n INTEGER NOT NULL CHECK (n >= 0))')
}, 60_000)
afterAll(async () => {
  await proxy?.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const count = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<{ n: number }>())!.n

test('the seed is there (this is the migrated local D1, not an empty one)', async () => {
  expect(await count(`SELECT COUNT(*) AS n FROM orders`)).toBeGreaterThan(20)
})

test('batch statements run in order', async () => {
  const results = await db.batch([
    db.prepare('INSERT INTO scratch (id, n) VALUES (1, 10)'),
    db.prepare('UPDATE scratch SET n = n * 2 WHERE id = 1'),
    db.prepare('UPDATE scratch SET n = n + 1 WHERE id = 1'),
    db.prepare('SELECT n FROM scratch WHERE id = 1'),
  ])
  // (10 * 2) + 1, not (10 + 1) * 2.
  expect(results[3]!.results).toEqual([{ n: 21 }])
})

test('changes() in statement N is what statement N-1 changed (the INSERT … WHERE changes() pattern)', async () => {
  await db.prepare('INSERT INTO scratch (id, n) VALUES (2, 0)').run()
  const marker = (tag: string) => db.prepare(`INSERT INTO scratch (n) SELECT ? WHERE changes() = 1`).bind(tag === 'hit' ? 100 : 200)
  await db.batch([db.prepare('UPDATE scratch SET n = 1 WHERE id = 2'), marker('hit')]) // matched one row
  await db.batch([db.prepare('UPDATE scratch SET n = 1 WHERE id = 999'), marker('miss')]) // matched none
  expect(await count('SELECT COUNT(*) AS n FROM scratch WHERE n = 100')).toBe(1)
  expect(await count('SELECT COUNT(*) AS n FROM scratch WHERE n = 200')).toBe(0)
  // And it carries down a chain: the 3rd statement sees the 2nd's insert, not the 1st's update.
  const r = await db.batch([
    db.prepare('UPDATE scratch SET n = n WHERE id IN (1, 2)'), // 2 rows
    db.prepare('INSERT INTO scratch (n) SELECT 300 WHERE changes() = 2'), // 1 row
    db.prepare('SELECT changes() AS c'),
  ])
  expect(r[2]!.results).toEqual([{ c: 1 }])
})

test('a failing statement rolls back the whole batch', async () => {
  const before = await count('SELECT COUNT(*) AS n FROM scratch')
  await expect(db.batch([
    db.prepare('INSERT INTO scratch (id, n) VALUES (50, 1)'),
    db.prepare('UPDATE scratch SET n = 999 WHERE id = 1'),
    db.prepare('INSERT INTO scratch (id, n) VALUES (51, -1)'), // CHECK fails
  ])).rejects.toThrow(/CHECK/)
  expect(await count('SELECT COUNT(*) AS n FROM scratch')).toBe(before)
  expect(await count('SELECT n FROM scratch WHERE id = 1')).toBe(21)
})

test('the real write paths: the re-derive after a PO revoke, a stale version, the counter, a trigger', async () => {
  const activity = () => count('SELECT COUNT(*) AS n FROM activity_log')
  // Order 5 is ready on approved PO 6: revoking moves it back, with the PO row and the re-derive row.
  let before = await activity()
  const v5 = (await dbo.orderState(db, { id: 5 }))!.version
  expect(await dbo.applyPoChange(db, { orderId: 5, poId: 6, actorId: 1, version: v5, from: 'approved', to: 'rejected' }))
    .toEqual({ changed: true, productionStatus: 'awaiting_authorization', version: v5 + 2 }) // the PO change and the re-derive each bump it
  expect(await activity()).toBe(before + 2)
  // A write with a stale version changes and logs nothing, even with data statements ahead of the guard.
  const o = (await dbo.getOrderByNumber(db, '2026-0022'))!
  await db.prepare('UPDATE orders SET title = ?, version = version + 1 WHERE id = ?').bind('intervening', o.id).run()
  before = await activity()
  expect(await dbo.replaceItems(db, { orderId: o.id, version: o.version, actorId: 1, items: [], itemsRevision: { from: 1, to: 2 } })).toBeNull()
  expect(await count('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', o.id)).toBe(2)
  expect(await activity()).toBe(before)
  // The counter creates its row on first use and the order reads its number back inside the batch.
  const n = await dbo.createOrder(db, { year: 2031, actorId: 1, customerId: 6, contactId: null, source: 'phone', title: 'first of 2031', dueDate: null,
    poRequired: false, paymentTerms: 'due_at_pickup', artworkRequired: true, productionStatus: 'awaiting_quote', items: [] })
  expect(n).toBe(1)
  expect(await dbo.orderState(db, { number: '2031-0001' })).toMatchObject({ productionStatus: 'awaiting_quote', version: 0 })
  // Migration 0002's triggers raise on workerd with a message the routes can map.
  await expect(db.prepare(`UPDATE quotes SET total_cents = 1 WHERE status = 'accepted'`).run()).rejects.toThrow(/quote_frozen/)
})

// Codex review of cce1dc9: the fixes lean on SQL that node:sqlite accepts; prove workerd's D1 runs it the same way.
test('a refused create or repeat uses no number: the conditional counter upsert (INSERT … SELECT … WHERE … ON CONFLICT … RETURNING)', async () => {
  const counters = async () => JSON.stringify((await db.prepare('SELECT * FROM counters ORDER BY year').all()).results)
  const orders = () => count('SELECT COUNT(*) AS n FROM orders')
  const base = { actorId: 1, source: 'phone', title: 'x', dueDate: null, poRequired: true, paymentTerms: 'due_after_pickup', artworkRequired: true, productionStatus: 'awaiting_quote', items: [] } satisfies Partial<Parameters<typeof dbo.createOrder>[1]>
  // A live contact: the year's row is created on first use, then counts up.
  expect(await dbo.createOrder(db, { ...base, year: 2032, customerId: 1, contactId: 2 })).toBe(1)
  expect(await dbo.createOrder(db, { ...base, year: 2032, customerId: 1, contactId: 2 })).toBe(2)
  await db.prepare(`UPDATE customer_contacts SET archived_at = '2026-10-01T00:00:00Z' WHERE id IN (2, 7)`).run()
  const [c0, o0, a0] = [await counters(), await orders(), await count('SELECT COUNT(*) AS n FROM activity_log')]
  expect(await dbo.createOrder(db, { ...base, year: 2032, customerId: 1, contactId: 2 })).toBeNull() // existing year row
  expect(await dbo.createOrder(db, { ...base, year: 2033, customerId: 1, contactId: 2 })).toBeNull() // no year row yet
  expect(await dbo.repeatOrder(db, { year: 2032, actorId: 1, sourceId: 15, source: 'phone', dueDate: null, productionStatus: 'awaiting_quote', paymentTerms: 'due_at_pickup' })).toBeNull() // contact 7
  expect([await counters(), await orders(), await count('SELECT COUNT(*) AS n FROM activity_log')]).toEqual([c0, o0, a0])
})

test('replace items on workerd: retained lines updated in place, a new line before the last row never takes its id', async () => {
  const n = (await dbo.createOrder(db, { year: 2034, actorId: 1, customerId: 6, contactId: null, source: 'phone', title: 'x', dueDate: null, poRequired: false,
    paymentTerms: 'due_at_pickup', artworkRequired: true, productionStatus: 'awaiting_quote',
    items: [{ kind: 'charge', description: 'Setup', product: null, garmentColor: null, method: null, sizes: null, quantity: 1, unitPriceCents: 100, notes: null }] }))!
  const o = (await dbo.orderState(db, { number: `2034-000${n}` }))!
  const id = (await db.prepare('SELECT id FROM orders WHERE number = ?').bind(o.number).first<{ id: number }>())!.id
  const [kept] = await dbo.listItems(db, id)
  const line = { kind: 'charge', description: 'New', product: null, garmentColor: null, method: null, sizes: null, quantity: 1, unitPriceCents: 50, notes: null } as const
  expect(await dbo.replaceItems(db, { orderId: id, version: o.version, actorId: 1, items: [line, { ...kept!, notes: 'kept' }], itemsRevision: { from: 0, to: 1 } })).not.toBeNull()
  const after = await dbo.listItems(db, id)
  expect(after.map((i) => [i.id === kept!.id, i.description, i.notes])).toEqual([[true, 'Setup', 'kept'], [false, 'New', null]])
})

// M5's batches lean on changes() through INSERT … RETURNING and past AFTER-trigger inserts (the void audit row).
// node:sqlite agrees; this checks the real workerd D1 too (M5 server report, 5fba130).
test('M5 writes on real D1: a check collects once, a payment records and voids once, each with one activity row', async () => {
  const { collectCheck, recordPayment, voidPayment } = await import('../../worker/db/payments')
  const acts = (action: string) => count(`SELECT COUNT(*) AS n FROM activity_log WHERE entity_id = 6 AND action = ?`, action)
  const version = async () => (await db.prepare('SELECT version FROM orders WHERE id = 6').first<{ version: number }>())!.version
  const payments = () => count('SELECT COUNT(*) AS n FROM payments WHERE order_id = 6')

  const p0 = await payments(), v0 = await version()
  expect(await collectCheck(db, { orderId: 6, actorId: 1, checkId: 2, amountCents: 72000, checkNumber: '881', paidOn: '2026-10-31' })).toBe(true)
  expect([await payments(), await acts('check_collected'), await version()]).toEqual([p0 + 1, 1, v0 + 1])
  expect(await collectCheck(db, { orderId: 6, actorId: 1, checkId: 2, amountCents: 72000, checkNumber: '881', paidOn: '2026-10-31' })).toBe(false) // retry
  expect([await payments(), await acts('check_collected'), await version()]).toEqual([p0 + 1, 1, v0 + 1])

  const id = await recordPayment(db, { orderId: 6, actorId: 1, version: v0 + 1, amountCents: 500, method: 'cash', paidOn: '2026-10-31', notes: null, requestId: 'd1-check-1' })
  expect(id).toEqual(expect.any(Number))
  expect([await payments(), await acts('payment_recorded'), await version()]).toEqual([p0 + 2, 1, v0 + 2])

  expect(await voidPayment(db, { orderId: 6, actorId: 1, version: v0 + 2, paymentId: id!, reason: 'entered twice' })).toBe(true)
  expect(await count(`SELECT COUNT(*) AS n FROM activity_log WHERE entity_id = 6 AND action LIKE '%void%'`)).toBe(1)
  expect(await version()).toBe(v0 + 3)
  expect(await voidPayment(db, { orderId: 6, actorId: 1, version: v0 + 3, paymentId: id!, reason: 'again' })).toBe(false)
  expect(await version()).toBe(v0 + 3)
})
