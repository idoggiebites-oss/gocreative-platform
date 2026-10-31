/// <reference types="vitest/globals" />
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { COLLECT_CHECK_SQL, RECORD_PAYMENT_SQL } from '../../worker/db/paymentSql.ts'
import { matchRetry } from '../../worker/domain/payments.ts'
import { createTestD1 } from './d1.ts'

const PAYMENTS = readFileSync(new URL('../../design/sql/payments.sql', import.meta.url), 'utf8')
let t: ReturnType<typeof createTestD1>
beforeEach(() => {
  t = createTestD1()
  t.sqlite.exec(PAYMENTS)
  t.sqlite.exec(`INSERT INTO users (id, email, name, role) VALUES (1, 'o@x', 'Owner', 'owner'), (2, 's@x', 'Staff', 'staff');
    INSERT INTO customers (id, kind, name) VALUES (1, 'district', 'District');
    INSERT INTO orders (id, number, customer_id, source, title) VALUES (1, 'GC-1', 1, 'email', 'Shirts');
    INSERT INTO check_collections (id, order_id, expected_cents, status) VALUES (1, 1, 5000, 'ready_for_collection'), (2, 1, 700, 'awaiting_payment')`)
})
afterEach(() => t.sqlite.close())

const all = (sql: string) => t.sqlite.prepare(sql).all()
const collect = (checkId: number, cents: number, by = 2) => t.db.batch([
  t.db.prepare(COLLECT_CHECK_SQL[0]).bind(cents, '2026-10-30T15:00:00Z', by, checkId),
  t.db.prepare(COLLECT_CHECK_SQL[1]).bind('2026-10-30', by, checkId),
  t.db.prepare(COLLECT_CHECK_SQL[2]).bind(checkId),
])
const record = (requestId: string | null, cents = 500, notes: string | null = null) =>
  t.db.prepare(RECORD_PAYMENT_SQL).bind(1, cents, 'cash', '2026-10-30', notes, 1, requestId).run()

it('a retried collect creates one payment and one activity row', async () => {
  await collect(1, 5000)
  const [update, insert, log] = await collect(1, 5000)
  expect([update.meta.changes, insert.meta.changes, log.meta.changes]).toEqual([0, 0, 0])
  expect(all('SELECT order_id, amount_cents, method, recorded_by, check_collection_id, request_id FROM payments'))
    .toEqual([{ order_id: 1, amount_cents: 5000, method: 'check', recorded_by: 2, check_collection_id: 1, request_id: null }])
  expect(all("SELECT action, actor_id, entity_id FROM activity_log")).toEqual([{ action: 'check_collected', actor_id: 2, entity_id: 1 }])
})

it('two competing collects of the same check create one payment, from the winner', async () => {
  // Both users see the check as collectable; D1 serializes the two batches.
  const results = await Promise.all([collect(2, 700, 1), collect(2, 650, 2)])
  expect(results.map(r => r[1].meta.changes).sort()).toEqual([0, 1])
  expect(all('SELECT amount_cents, recorded_by FROM payments')).toEqual([{ amount_cents: 700, recorded_by: 1 }])
  expect(all('SELECT status, amount_received_cents, collected_by FROM check_collections WHERE id = 2')).toEqual([{ status: 'collected', amount_received_cents: 700, collected_by: 1 }])
  expect(all('SELECT id FROM activity_log')).toHaveLength(1)
})

it('a failing payment insert (amount 0) rolls back the collection status', async () => {
  await expect(collect(1, 0)).rejects.toThrow(/CHECK constraint failed/)
  expect(all('SELECT status, amount_received_cents, collected_by FROM check_collections WHERE id = 1')).toEqual([{ status: 'ready_for_collection', amount_received_cents: null, collected_by: null }])
  expect(all('SELECT id FROM payments')).toEqual([])
  expect(all('SELECT id FROM activity_log')).toEqual([])
  await collect(1, 5000) // still collectable
  expect(all('SELECT id FROM payments')).toHaveLength(1)
})

it('manual payments need a non-blank request_id, and each request_id records once', async () => {
  for (const requestId of [null, '', '   ']) await expect(record(requestId)).rejects.toThrow(/CHECK constraint failed/)
  await record('req-1')
  await expect(record('req-1')).rejects.toThrow(/UNIQUE constraint failed: payments.request_id/)
  // The route then resolves the duplicate: identical retry -> the stored payment; different payload -> 409.
  const stored = t.sqlite.prepare("SELECT id, order_id AS orderId, amount_cents AS amountCents, method, paid_on AS paidOn, notes FROM payments WHERE request_id = 'req-1'").get() as Parameters<typeof matchRetry>[0]
  expect(matchRetry(stored, { orderId: 1, amountCents: 500, method: 'cash', paidOn: '2026-10-30', notes: null })).toMatchObject({ ok: true, payment: stored })
  expect(matchRetry(stored, { orderId: 1, amountCents: 600, method: 'cash', paidOn: '2026-10-30', notes: null })).toEqual({ ok: false, error: 'request_id_conflict' })
  expect(all('SELECT id FROM payments')).toHaveLength(1)
})

it('rejects bad amounts and methods, and locks a payment to its check collection', async () => {
  for (const cents of [0, -1, 1.5]) await expect(record(`r${cents}`, cents)).rejects.toThrow(/CHECK constraint failed/)
  await expect(t.db.prepare(RECORD_PAYMENT_SQL).bind(1, 100, 'bitcoin', '2026-10-30', null, 1, 'r-m').run()).rejects.toThrow(/CHECK constraint failed/)
  await collect(1, 5000)
  await record('req-2')
  expect(() => t.sqlite.exec('UPDATE payments SET check_collection_id = 2 WHERE check_collection_id = 1')).toThrow(/payment_check_link_immutable/)
  expect(() => t.sqlite.exec('UPDATE payments SET check_collection_id = NULL WHERE check_collection_id = 1')).toThrow(/payment_check_link_immutable/)
  expect(() => t.sqlite.exec("UPDATE payments SET check_collection_id = 2 WHERE request_id = 'req-2'")).toThrow(/payment_check_link_immutable/)
  expect(() => t.sqlite.exec('DELETE FROM payments WHERE check_collection_id = 1')).toThrow(/payment_linked_to_check/)
  // A second payment can't claim an already-collected check.
  expect(() => t.sqlite.exec("INSERT INTO payments (order_id, amount_cents, method, paid_on, recorded_by, check_collection_id) VALUES (1, 1, 'check', '2026-10-30', 1, 1)"))
    .toThrow(/UNIQUE constraint failed: payments.check_collection_id/)
  t.sqlite.exec("DELETE FROM payments WHERE request_id = 'req-2'") // unlinked manual payments stay deletable (corrections)
})
