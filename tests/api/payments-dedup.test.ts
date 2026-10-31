/// <reference types="vitest/globals" />
/// <reference types="node" />
// PHASE2_PLAN §4.4 on the real schema (migrations 0001 … 0006 + the seed): COLLECT_CHECK_SQL and RECORD_PAYMENT_SQL as
// the M5 routes run them. Order 2026-0006 (id 6, a district, picked up unpaid) holds the test checks.
import { readFileSync } from 'node:fs'
import { COLLECT_CHECK_SQL, RECORD_PAYMENT_SQL } from '../../worker/db/paymentSql.ts'
import { matchRetry } from '../../worker/domain/payments.ts'
import { createTestD1 } from './d1.ts'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
let t: ReturnType<typeof createTestD1>
beforeEach(() => {
  t = createTestD1()
  t.sqlite.exec(seed)
  t.sqlite.exec(`INSERT INTO users (id, email, name, role) VALUES (3, 's@x', 'Staff', 'staff');
    INSERT INTO check_collections (id, order_id, expected_cents, status) VALUES (11, 6, 5000, 'ready_for_collection'), (12, 6, 700, 'awaiting_payment')`)
})
afterEach(() => t.sqlite.close())

const all = (sql: string) => t.sqlite.prepare(sql).all()
const version = () => (t.sqlite.prepare('SELECT version FROM orders WHERE id = 6').get() as { version: number }).version
const collect = (checkId: number, cents: number, by = 3) => t.db.batch([
  t.db.prepare(COLLECT_CHECK_SQL[0]).bind(cents, '2026-10-30T15:00:00Z', by, checkId),
  t.db.prepare(COLLECT_CHECK_SQL[1]).bind('2026-10-30', by, checkId),
  t.db.prepare(COLLECT_CHECK_SQL[2]).bind(checkId),
])
const record = (requestId: string | null, cents = 500, notes: string | null = null, v = version()) =>
  t.db.prepare(RECORD_PAYMENT_SQL).bind(6, cents, 'cash', '2026-10-30', notes, 1, requestId, 6, v).run()
const testPayments = (where = '') => all(`SELECT order_id, amount_cents, method, recorded_by, check_collection_id, request_id FROM payments WHERE order_id = 6 ${where} ORDER BY id`)
const testActivity = () => all(`SELECT action, actor_id, entity_id FROM activity_log WHERE action = 'check_collected' AND entity_id = 6`)

it('a retried collect creates one payment and one activity row', async () => {
  await collect(11, 5000)
  const [update, insert, log] = await collect(11, 5000)
  expect([update.meta.changes, insert.meta.changes, log.meta.changes]).toEqual([0, 0, 0])
  expect(testPayments()).toEqual([{ order_id: 6, amount_cents: 5000, method: 'check', recorded_by: 3, check_collection_id: 11, request_id: null }])
  expect(testActivity()).toEqual([{ action: 'check_collected', actor_id: 3, entity_id: 6 }])
})

it('two competing collects of the same check create one payment, from the winner, in either order', async () => {
  for (const [first, second] of [[[1, 700], [3, 650]], [[3, 650], [1, 700]]] as const) {
    t.sqlite.close()
    t = createTestD1()
    t.sqlite.exec(seed)
    t.sqlite.exec(`INSERT INTO users (id, email, name, role) VALUES (3, 's@x', 'Staff', 'staff');
      INSERT INTO check_collections (id, order_id, expected_cents, status) VALUES (12, 6, 700, 'awaiting_payment')`)
    // Both users saw the check as collectable; D1 serializes the two batches.
    const results = await Promise.all([collect(12, first[1], first[0]), collect(12, second[1], second[0])])
    expect(results.map((r) => r[1].meta.changes)).toEqual([1, 0])
    expect(testPayments()).toEqual([{ order_id: 6, amount_cents: first[1], method: 'check', recorded_by: first[0], check_collection_id: 12, request_id: null }])
    expect(all('SELECT status, amount_received_cents, collected_by FROM check_collections WHERE id = 12')).toEqual([{ status: 'collected', amount_received_cents: first[1], collected_by: first[0] }])
    expect(testActivity()).toHaveLength(1)
  }
})

it('a failing payment insert (amount 0) rolls back the collection status', async () => {
  await expect(collect(11, 0)).rejects.toThrow(/CHECK constraint failed/)
  expect(all('SELECT status, amount_received_cents, collected_by FROM check_collections WHERE id = 11')).toEqual([{ status: 'ready_for_collection', amount_received_cents: null, collected_by: null }])
  expect(testPayments()).toEqual([])
  expect(testActivity()).toEqual([])
  await collect(11, 5000) // still collectable
  expect(testPayments()).toHaveLength(1)
})

it('manual payments need a non-blank request_id, and each request_id records once', async () => {
  for (const requestId of [null, '', '   ']) await expect(record(requestId)).rejects.toThrow(/CHECK constraint failed/)
  await record('req-1')
  await expect(record('req-1')).rejects.toThrow(/payment_request_id_exists/)
  // The route then resolves the duplicate: identical retry -> the stored payment; different payload -> 409.
  const stored = t.sqlite.prepare("SELECT id, order_id AS orderId, amount_cents AS amountCents, method, paid_on AS paidOn, notes FROM payments WHERE request_id = 'req-1'").get() as Parameters<typeof matchRetry>[0]
  expect(matchRetry(stored, { orderId: 6, amountCents: 500, method: 'cash', paidOn: '2026-10-30', notes: null })).toMatchObject({ ok: true, payment: stored })
  expect(matchRetry(stored, { orderId: 6, amountCents: 600, method: 'cash', paidOn: '2026-10-30', notes: null })).toEqual({ ok: false, error: 'request_id_conflict' })
  expect(testPayments()).toHaveLength(1)
})

it('a stale order version or a cancelled order inserts nothing', async () => {
  expect((await record('req-stale', 500, null, version() + 1)).meta.changes).toBe(0)
  t.sqlite.exec(`UPDATE orders SET state = 'cancelled' WHERE id = 6`)
  expect((await record('req-cancelled')).meta.changes).toBe(0)
  expect(testPayments()).toEqual([])
})

it('rejects bad amounts and methods, and locks a payment to its check collection', async () => {
  for (const cents of [0, -1, 1.5]) await expect(record(`r${cents}`, cents)).rejects.toThrow(/CHECK constraint failed/)
  await expect(t.db.prepare(RECORD_PAYMENT_SQL).bind(6, 100, 'bitcoin', '2026-10-30', null, 1, 'r-m', 6, version()).run()).rejects.toThrow(/CHECK constraint failed/)
  await collect(11, 5000)
  await record('req-2')
  expect(() => t.sqlite.exec('UPDATE payments SET check_collection_id = 12 WHERE check_collection_id = 11')).toThrow(/payment_check_link_immutable|payment_immutable/)
  expect(() => t.sqlite.exec('UPDATE payments SET check_collection_id = NULL WHERE check_collection_id = 11')).toThrow(/payment_check_link_immutable|payment_immutable/)
  expect(() => t.sqlite.exec("UPDATE payments SET check_collection_id = 12 WHERE request_id = 'req-2'")).toThrow(/payment_check_link_immutable|payment_immutable/)
  expect(() => t.sqlite.exec('DELETE FROM payments WHERE check_collection_id = 11')).toThrow(/payment_linked_to_check/)
  // A second payment can't claim an already-collected check, even through REPLACE.
  for (const verb of ['INSERT', 'INSERT OR REPLACE']) {
    expect(() => t.sqlite.exec(`${verb} INTO payments (order_id, amount_cents, method, paid_on, recorded_by, check_collection_id) VALUES (6, 1, 'check', '2026-10-30', 1, 11)`))
      .toThrow(/payment_check_exists/)
  }
  // Corrections are voids: an unlinked manual payment is not deletable either (PHASE2_PLAN, carried forward to M5).
  expect(() => t.sqlite.exec("DELETE FROM payments WHERE request_id = 'req-2'")).toThrow(/payments are never deleted/)
  expect(testPayments()).toHaveLength(2)
})
