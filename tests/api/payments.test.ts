// M5 payments and check collection through the real /api/app routes on the seeded D1 (seed: tests/api/m5.ts), each DB
// writer called directly with a stale version, interleavings in both orders, and migration 0006's triggers hit with
// direct SQL. The COLLECT_CHECK_SQL statements themselves are proven in payments-dedup.test.ts.
import { describe, expect, test } from 'vitest'
import type { CheckWriteResponse, DashboardResponse, PaymentsPageResponse, PaymentsResponse, RecordPaymentResponse } from '../../shared/api'
import { CHECK_STATUSES, PAYMENT_METHODS } from '../../shared/enums'
import { businessToday, daysBetween } from '../../shared/businessDate'
import * as dbm from '../../worker/db/payments'
import { setup, STAFF } from './m5'

type T = ReturnType<typeof setup>
const payments = async (t: T, n: string) => (await t.call<PaymentsResponse>('GET', `/orders/${n}/payments`)).body
const checkPost = (t: T, id: number, move: string, body: object = {}, email?: string) => t.call<CheckWriteResponse>('POST', `/checks/${id}/${move}`, body, email)
const newCheck = (t: T, n: string, body: object = {}) => t.call<CheckWriteResponse>('POST', `/orders/${n}/checks`, { expectedCents: 73000, expectedVersion: t.o(n).version, ...body })
const countPayments = (t: T) => t.one<{ n: number }>('SELECT COUNT(*) AS n FROM payments').n

describe('manual payments', () => {
  test('record, an identical retry (even from the old version) returns the stored payment, a different payload under the same requestId is 409', async () => {
    const t = setup()
    const v = t.o('2026-0020').version
    const body = { amountCents: 10000, method: 'card', paidOn: '2026-10-30', notes: ' at the counter ', requestId: 'form-1', expectedVersion: v }
    const first = await t.call<RecordPaymentResponse>('POST', '/orders/2026-0020/payments', body, STAFF)
    expect(first).toMatchObject({ status: 201, body: { replayed: false, version: v + 1, payment: { amountCents: 10000, method: 'card', paidOn: '2026-10-30', notes: 'at the counter', recordedBy: 'Staff', voided: null } } })
    expect(t.acts('2026-0020', 'payment_recorded')).toEqual([{ actor_id: 3, action: 'payment_recorded', before: null, after: '{"amount_cents":10000,"method":"card","paid_on":"2026-10-30"}' }])
    const before = t.footprint()
    const retry = await t.call<RecordPaymentResponse>('POST', '/orders/2026-0020/payments', body, STAFF)
    expect(retry).toMatchObject({ status: 200, body: { replayed: true, version: v + 1, payment: { id: first.body.payment.id } } })
    // paidOn left out on the retry means what it resolved to the first time.
    const { paidOn: _, ...noDate } = body
    expect((await t.call('POST', '/orders/2026-0020/payments', noDate, STAFF)).status).toBe(200)
    for (const patch of [{ amountCents: 10001 }, { method: 'cash' }, { paidOn: '2026-10-31' }, { notes: 'other' }]) {
      expect(await t.call('POST', '/orders/2026-0020/payments', { ...body, ...patch }), JSON.stringify(patch)).toMatchObject({ status: 409, body: { code: 'request_id_conflict' } })
    }
    // The same requestId on another order is a conflict too, never that order's payment.
    expect(await t.call('POST', '/orders/2026-0006/payments', { ...body, expectedVersion: t.o('2026-0006').version })).toMatchObject({ status: 409, body: { code: 'request_id_conflict' } })
    expect(t.footprint()).toEqual(before)
  })

  test('a new requestId at a stale version is 409 conflict_retry; validation and cancelled orders refuse; nothing written', async () => {
    const t = setup()
    const before = t.footprint()
    expect(await t.pay('2026-0020', 100, { expectedVersion: t.o('2026-0020').version + 1 })).toMatchObject({ status: 409, body: { code: 'conflict_retry' } })
    for (const bad of [{ amountCents: 0 }, { amountCents: -5 }, { amountCents: 1.5 }, { method: 'bitcoin' }, { requestId: '  ' }, { paidOn: '2026-02-30' }]) {
      expect((await t.pay('2026-0020', 100, bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect(await t.pay('2026-0024', 100)).toMatchObject({ status: 409, body: { code: 'order_not_active' } })
    expect(t.footprint()).toEqual(before)
  })

  test('balance: multiple payments add up, an overpayment is a credit (paid), never a negative balance', async () => {
    const t = setup()
    await t.pay('2026-0020', 100000)
    expect((await payments(t, '2026-0020')).balance).toEqual({ agreedCents: 230300, receivedCents: 150000, outstandingCents: 80300, creditCents: 0, status: 'partially_paid' })
    await t.pay('2026-0020', 90000)
    expect((await payments(t, '2026-0020')).balance).toEqual({ agreedCents: 230300, receivedCents: 240000, outstandingCents: 0, creditCents: 9700, status: 'paid' })
  })
})

describe('voids', () => {
  test('owner only, reason required; the row stays (with its requestId), stops counting, one audit row, and can’t be voided again', async () => {
    const t = setup()
    const p = await t.pay('2026-0020', 30000, { requestId: 'void-me' })
    const id = (p.body as RecordPaymentResponse).payment.id
    const path = `/orders/2026-0020/payments/${id}/void`
    const before = t.footprint()
    expect(await t.call('POST', path, { reason: 'typo', expectedVersion: t.o('2026-0020').version }, STAFF)).toMatchObject({ status: 403, body: { code: 'void_requires_owner' } })
    expect((await t.call('POST', path, { reason: '  ', expectedVersion: t.o('2026-0020').version })).status).toBe(400)
    expect(await t.call('POST', path, { reason: 'typo', expectedVersion: t.o('2026-0020').version - 1 })).toMatchObject({ status: 409, body: { code: 'conflict_retry' } })
    expect(t.footprint()).toEqual(before)
    expect((await t.call('POST', path, { reason: ' Wrong amount ', expectedVersion: t.o('2026-0020').version })).status).toBe(200)
    const after = await payments(t, '2026-0020')
    expect(after.payments.find((x) => x.id === id)).toMatchObject({ amountCents: 30000, voided: { by: 'Owner One', reason: 'Wrong amount' } })
    expect(after.balance).toMatchObject({ receivedCents: 50000, outstandingCents: 180300 })
    expect(t.one<{ request_id: string }>('SELECT request_id FROM payments WHERE id = ?', id).request_id).toBe('void-me')
    expect(t.acts('2026-0020', 'payment_voided')).toEqual([{ actor_id: 1, action: 'payment_voided', before: null, after: JSON.stringify({ payment_id: id, amount_cents: 30000, method: 'cash', reason: 'Wrong amount' }) }])
    expect(await t.call('POST', path, { reason: 'again', expectedVersion: t.o('2026-0020').version })).toMatchObject({ status: 409, body: { code: 'payment_voided' } })
    // Resubmitting the voided payment's form is still the same submission: it answers with the (voided) payment.
    expect((await t.pay('2026-0020', 30000, { requestId: 'void-me', paidOn: after.payments.find((x) => x.id === id)!.paidOn })).body).toMatchObject({ replayed: true, payment: { id } })
  })

  test('a void that leaves a closed order unpaid makes it active again, logged as order_reopened', async () => {
    const t = setup()
    const card = t.one<{ id: number }>(`SELECT id FROM payments WHERE order_id = 15 AND method = 'card'`).id
    expect((await t.call('POST', `/orders/2026-0015/payments/${card}/void`, { reason: 'Card charge reversed', expectedVersion: t.o('2026-0015').version })).body).toMatchObject({ state: 'active' })
    expect(t.acts('2026-0015', 'order_reopened')).toEqual([{ actor_id: 1, action: 'order_reopened', before: '{"state":"closed"}', after: '{"state":"active","reason":"payment_voided"}' }])
    // Paying again closes it again.
    expect((await t.pay('2026-0015', 18000)).body).toMatchObject({ state: 'closed' })
  })
})

describe('check collection', () => {
  test('pay-after-pickup orders only; the full flow creates exactly one payment; deposit and clear never touch payments', async () => {
    const t = setup()
    expect(await newCheck(t, '2026-0020')).toMatchObject({ status: 409, body: { code: 'check_not_allowed' } })
    const created = await newCheck(t, '2026-0004', { availableOn: '2026-11-05', checkNumber: ' 5521 ', notes: 'Front office' })
    expect(created).toMatchObject({ status: 201, body: { check: { status: 'awaiting_payment', expectedCents: 73000, availableOn: '2026-11-05', checkNumber: '5521', paymentId: null } } })
    const id = created.body.check.id
    const ready = await checkPost(t, id, 'ready', { availableOn: '2026-11-03' }, STAFF)
    expect(ready).toMatchObject({ status: 200, body: { check: { status: 'ready_for_collection', availableOn: '2026-11-03' } } })
    const n = countPayments(t)
    const collected = await checkPost(t, id, 'collect', { amountReceivedCents: 73000, collectedOn: '2026-11-04' }, STAFF)
    expect(collected).toMatchObject({ status: 200, body: { check: { status: 'collected', amountReceivedCents: 73000, collectedBy: 'Staff' } } })
    expect(countPayments(t)).toBe(n + 1)
    expect(t.one('SELECT amount_cents, method, paid_on, recorded_by FROM payments WHERE check_collection_id = ?', id)).toEqual({ amount_cents: 73000, method: 'check', paid_on: '2026-11-04', recorded_by: 3 })
    expect((await payments(t, '2026-0004')).balance).toMatchObject({ receivedCents: 73000, status: 'paid' })
    const paymentsBefore = t.footprint().payments
    expect((await checkPost(t, id, 'deposit', { depositedOn: '2026-11-05' })).body.check).toMatchObject({ status: 'deposited', depositedOn: '2026-11-05' })
    expect((await checkPost(t, id, 'clear', { clearedOn: '2026-11-08' })).body.check).toMatchObject({ status: 'cleared', clearedOn: '2026-11-08' })
    expect(t.footprint().payments).toEqual(paymentsBefore)
    expect(t.acts('2026-0004').map((a) => a.action).filter((a) => a.startsWith('check_'))).toEqual(['check_created', 'check_ready', 'check_collected', 'check_deposited', 'check_cleared'])
    // Paid but not picked up: still active (only both close it).
    expect(t.o('2026-0004').state).toBe('active')
  })

  test('statuses can’t be skipped or repeated, by route or by SQL; nothing written on refusal', async () => {
    const t = setup()
    const id = (await newCheck(t, '2026-0004')).body.check.id
    const before = t.footprint()
    expect(await checkPost(t, id, 'deposit')).toMatchObject({ status: 409, body: { code: 'invalid_check_transition' } })
    expect(await checkPost(t, id, 'clear')).toMatchObject({ status: 409, body: { code: 'invalid_check_transition' } })
    expect(t.footprint()).toEqual(before)
    // awaiting -> collected directly is allowed (the district handed it over without notice).
    expect((await checkPost(t, id, 'collect', { amountReceivedCents: 73000 })).status).toBe(200)
    expect(await checkPost(t, id, 'ready')).toMatchObject({ status: 409, body: { code: 'invalid_check_transition' } })
    expect(await checkPost(t, id, 'clear')).toMatchObject({ status: 409, body: { code: 'invalid_check_transition' } })
    expect(() => t.sqlite.exec(`UPDATE check_collections SET status = 'cleared', cleared_on = '2026-11-01', deposited_on = '2026-11-01' WHERE id = ${id}`)).toThrow(/invalid_check_transition/)
    expect(() => t.sqlite.exec(`UPDATE check_collections SET status = 'ready_for_collection' WHERE id = ${id}`)).toThrow(/invalid_check_transition/)
    expect(() => t.sqlite.exec(`INSERT INTO check_collections (order_id, expected_cents, status, amount_received_cents, collected_at, collected_by) VALUES (4, 5, 'collected', 5, 'x', 1)`)).toThrow(/invalid_check_transition/)
    expect(() => t.sqlite.exec(`UPDATE check_collections SET status = 'deposited' WHERE id = ${id}`)).toThrow(/CHECK constraint failed/) // no deposit date
  })

  test('collect retried with the same amount: 200, no second payment or activity; a different amount is 409, also after a lost race', async () => {
    const t = setup()
    const first = await checkPost(t, 2, 'collect', { amountReceivedCents: 72000, checkNumber: '881' })
    expect(first).toMatchObject({ status: 200, body: { check: { status: 'collected', checkNumber: '881' } } })
    const before = t.footprint()
    expect(await checkPost(t, 2, 'collect', { amountReceivedCents: 72000, checkNumber: '881' })).toMatchObject({ status: 200, body: { check: { id: 2, paymentId: first.body.check.paymentId } } })
    expect(await checkPost(t, 2, 'collect', { amountReceivedCents: 72000 }, STAFF)).toMatchObject({ status: 200 })
    expect(await checkPost(t, 2, 'collect', { amountReceivedCents: 71000 })).toMatchObject({ status: 409, body: { code: 'check_collect_conflict' } })
    expect(await checkPost(t, 2, 'collect', { amountReceivedCents: 72000, checkNumber: '999' })).toMatchObject({ status: 409, body: { code: 'check_collect_conflict' } })
    expect(t.footprint()).toEqual(before)
    // Lost race: someone collects for 500 between this request's read and its write; the read-back answers 409.
    const t2 = setup()
    const id = (await newCheck(t2, '2026-0004')).body.check.id
    await dbm.collectCheck(t2.db, { orderId: 4, actorId: 2, checkId: id, amountCents: 500, checkNumber: null, paidOn: '2026-10-31' })
    expect(await checkPost(t2, id, 'collect', { amountReceivedCents: 73000 })).toMatchObject({ status: 409, body: { code: 'check_collect_conflict' } })
    expect(t2.one<{ n: number }>('SELECT COUNT(*) AS n FROM payments WHERE check_collection_id = ?', id).n).toBe(1)
  })

  test('collecting the check that pays off a picked-up district order closes it in the same write', async () => {
    const t = setup()
    expect((await checkPost(t, 2, 'collect', { amountReceivedCents: 72000 })).body).toMatchObject({ state: 'closed' })
    expect(t.acts('2026-0006').slice(-2).map((a) => a.action)).toEqual(['check_collected', 'order_closed'])
  })
})

describe('the SQL guards', () => {
  test('each writer called directly with a stale version or a moved check changes and logs nothing', async () => {
    const t = setup()
    const v = t.o('2026-0004').version
    const before = t.footprint()
    expect(await dbm.recordPayment(t.db, { orderId: 4, version: v - 1, actorId: 1, amountCents: 5, method: 'cash', paidOn: '2026-10-30', notes: null, requestId: 'stale' })).toBeNull()
    expect(await dbm.createCheck(t.db, { orderId: 4, version: v - 1, actorId: 1, expectedCents: 5, availableOn: null, checkNumber: null, notes: null })).toBeNull()
    const voidable = t.one<{ id: number }>(`SELECT id FROM payments WHERE order_id = 20`).id
    expect(await dbm.voidPayment(t.db, { orderId: 20, version: t.o('2026-0020').version - 1, actorId: 1, paymentId: voidable, reason: 'stale' })).toBe(false)
    // Check moves are guarded by the check's status: from the wrong one, nothing happens.
    expect(await dbm.moveCheck(t.db, { orderId: 6, actorId: 1, checkId: 2, to: 'deposited', on: '2026-10-31' })).toBe(false)
    expect(await dbm.moveCheck(t.db, { orderId: 6, actorId: 1, checkId: 2, to: 'ready_for_collection', on: '2026-10-31' })).toBe(false)
    expect(await dbm.moveCheck(t.db, { orderId: 1, actorId: 1, checkId: 1, to: 'cleared', on: '2026-10-31' })).toBe(false)
    expect(t.footprint()).toEqual(before)
    // And a check can't be created on a pay-at-pickup order even at the right version.
    expect(await dbm.createCheck(t.db, { orderId: 20, version: t.o('2026-0020').version, actorId: 1, expectedCents: 5, availableOn: null, checkNumber: null, notes: null })).toBeNull()
    expect(t.footprint()).toEqual(before)
  })

  test('two collects of one check, both orders: one payment, the second changes nothing', async () => {
    for (const [a, b] of [[72000, 70000], [70000, 72000]]) {
      const t = setup()
      const go = (cents: number) => dbm.collectCheck(t.db, { orderId: 6, actorId: 1, checkId: 2, amountCents: cents, checkNumber: null, paidOn: '2026-10-31' })
      expect(await go(a)).toBe(true)
      const after = t.footprint()
      expect(await go(b)).toBe(false)
      expect(t.footprint()).toEqual(after)
      expect(t.one('SELECT amount_cents FROM payments WHERE check_collection_id = 2')).toEqual({ amount_cents: a })
    }
  })

  test('collect vs void from the same order version: a void read before the collect is refused; a void first leaves the collect free', async () => {
    // Collect first: it bumps the order version, so the void prepared at the old version changes nothing.
    {
      const t = setup()
      const v = t.o('2026-0006').version
      const manual = await dbm.recordPayment(t.db, { orderId: 6, version: v, actorId: 1, amountCents: 100, method: 'cash', paidOn: '2026-10-31', notes: null, requestId: 'm' })
      const v2 = t.o('2026-0006').version
      expect(await dbm.collectCheck(t.db, { orderId: 6, actorId: 1, checkId: 2, amountCents: 72000, checkNumber: null, paidOn: '2026-10-31' })).toBe(true)
      const after = t.footprint()
      expect(await dbm.voidPayment(t.db, { orderId: 6, version: v2, actorId: 1, paymentId: manual!, reason: 'r' })).toBe(false)
      expect(t.footprint()).toEqual(after)
    }
    // Void first: the collect is guarded by the check's status, not the version, so it still applies (one payment).
    {
      const t = setup()
      const v = t.o('2026-0006').version
      const manual = await dbm.recordPayment(t.db, { orderId: 6, version: v, actorId: 1, amountCents: 100, method: 'cash', paidOn: '2026-10-31', notes: null, requestId: 'm' })
      expect(await dbm.voidPayment(t.db, { orderId: 6, version: t.o('2026-0006').version, actorId: 1, paymentId: manual!, reason: 'r' })).toBe(true)
      expect(await dbm.collectCheck(t.db, { orderId: 6, actorId: 1, checkId: 2, amountCents: 72000, checkNumber: null, paidOn: '2026-10-31' })).toBe(true)
      expect(t.one<{ n: number }>('SELECT COUNT(*) AS n FROM payments WHERE check_collection_id = 2').n).toBe(1)
      expect(t.o('2026-0006').state).toBe('closed')
    }
  })

  test('direct SQL can’t replace, re-key, edit, un-void or delete a payment, nor void without an owner and a reason', () => {
    const t = setup()
    const before = t.footprint()
    for (const verb of ['INSERT OR REPLACE', 'REPLACE']) {
      expect(() => t.sqlite.exec(`${verb} INTO payments (order_id, amount_cents, method, paid_on, recorded_by, request_id) VALUES (20, 1, 'cash', '2026-10-30', 1, 'seed-payment-5')`), verb)
        .toThrow(/payment_request_id_exists/)
      expect(() => t.sqlite.exec(`${verb} INTO payments (id, order_id, amount_cents, method, paid_on, recorded_by, request_id) VALUES (5, 20, 1, 'cash', '2026-10-30', 1, 'new')`), verb)
        .toThrow(/payment_exists/)
    }
    for (const alias of ['id', 'rowid', 'oid', '_rowid_']) expect(() => t.sqlite.exec(`UPDATE payments SET ${alias} = 999 WHERE id = 5`), alias).toThrow(/payment_immutable/)
    expect(() => t.sqlite.exec(`UPDATE OR REPLACE payments SET request_id = 'seed-payment-2' WHERE id = 5`)).toThrow(/payment_immutable/)
    expect(() => t.sqlite.exec(`UPDATE payments SET amount_cents = 1 WHERE id = 5`)).toThrow(/payment_immutable/)
    expect(() => t.sqlite.exec(`UPDATE payments SET voided_at = NULL, voided_by = NULL, void_reason = NULL WHERE id = 3`)).toThrow(/payment_voided/)
    expect(() => t.sqlite.exec(`UPDATE payments SET void_reason = 'changed' WHERE id = 3`)).toThrow(/payment_voided/)
    expect(() => t.sqlite.exec(`UPDATE payments SET voided_at = 'now', voided_by = 3, void_reason = 'staff' WHERE id = 5`)).toThrow(/void_requires_owner/)
    expect(() => t.sqlite.exec(`UPDATE payments SET voided_at = 'now', voided_by = 1, void_reason = ' ' WHERE id = 5`)).toThrow(/CHECK constraint failed/)
    expect(() => t.sqlite.exec(`UPDATE payments SET voided_at = 'now', voided_by = 1 WHERE id = 5`)).toThrow(/CHECK constraint failed/)
    expect(() => t.sqlite.exec(`DELETE FROM payments WHERE id = 5`)).toThrow(/payments are never deleted/)
    expect(() => t.sqlite.exec(`DELETE FROM payments WHERE id = 1`)).toThrow(/payment_linked_to_check/)
    expect(t.footprint()).toEqual(before)
  })

  test('direct SQL can’t replace, re-key, rewrite or delete a check collection', () => {
    const t = setup()
    const before = t.footprint()
    expect(() => t.sqlite.exec(`INSERT OR REPLACE INTO check_collections (id, order_id, expected_cents) VALUES (1, 6, 5)`)).toThrow(/check_exists/)
    for (const alias of ['id', 'rowid', 'oid', '_rowid_']) expect(() => t.sqlite.exec(`UPDATE check_collections SET ${alias} = 999 WHERE id = 2`), alias).toThrow(/check_fixed/)
    expect(() => t.sqlite.exec(`UPDATE check_collections SET order_id = 1 WHERE id = 2`)).toThrow(/check_fixed/)
    expect(() => t.sqlite.exec(`UPDATE check_collections SET expected_cents = 1 WHERE id = 2`)).toThrow(/check_fixed/)
    expect(() => t.sqlite.exec(`UPDATE check_collections SET amount_received_cents = 1 WHERE id = 1`)).toThrow(/check_fixed/)
    expect(() => t.sqlite.exec(`UPDATE check_collections SET cleared_on = '2026-01-01' WHERE id = 1`)).toThrow(/check_fixed/)
    expect(() => t.sqlite.exec(`UPDATE check_collections SET deposited_on = '2026-01-01' WHERE id = 1`)).toThrow(/check_fixed/)
    expect(() => t.sqlite.exec(`DELETE FROM check_collections WHERE id = 2`)).toThrow(/never deleted/)
    expect(t.footprint()).toEqual(before)
  })

  test('the payment method and check status CHECKs match shared/enums.ts', () => {
    const t = setup()
    const list = (table: string, column: string) =>
      [...t.one<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = ?`, table).sql.match(new RegExp(`\\b${column} IN \\(([^)]*)\\)`))![1].matchAll(/'([^']*)'/g)].map((m) => m[1])
    expect(list('payments', 'method')).toEqual([...PAYMENT_METHODS])
    expect(list('check_collections', 'status')).toEqual([...CHECK_STATUSES])
  })
})

describe('the Payments page and the dashboard', () => {
  test('outstanding: finished active orders that owe, with days, collection status and next action; checks grouped', async () => {
    const t = setup()
    const page = (await t.call<PaymentsPageResponse>('GET', '/payments')).body
    expect(page.outstanding.map((r) => [r.number, r.outstandingCents, r.fulfilmentStatus, r.collectionStatus, r.nextAction])).toEqual([
      ['2026-0006', 72000, 'picked_up', 'ready_for_collection', 'collect_check'],
      ['2026-0020', 180300, 'customer_notified', null, 'collect_at_pickup'],
    ])
    // Days in shop time: from the pickup (district) and from ready (pay at pickup). The seed's dates are UTC-relative.
    const today = businessToday(new Date())
    const days = (col: string, id: number) => daysBetween(t.one<Record<string, string>>(`SELECT ${col} AS d FROM pickups WHERE order_id = ?`, id).d, today)
    expect(page.outstanding[0]).toMatchObject({ customerName: 'Maple Ridge School District', paymentTerms: 'due_after_pickup', financialStatus: 'unpaid', daysOutstanding: days('picked_up_on', 6) })
    expect(page.outstanding[1]).toMatchObject({ daysOutstanding: days('ready_on', 20), receivedCents: 50000, agreedCents: 230300 })
    expect(page.checksToCollect.map((k) => [k.id, k.orderNumber, k.customerName])).toEqual([[2, '2026-0006', 'Maple Ridge School District']])
    expect([page.checksAwaitingPayment, page.checksInHand]).toEqual([[], []])
    const d = (await t.call<DashboardResponse>('GET', '/dashboard')).body
    expect(d.outstandingPayments).toEqual({ count: 2, totalCents: 252300, oldestDays: page.outstanding[0].daysOutstanding })
    // Picked-up orders are no longer ready for pickup.
    expect(d.metrics.readyForPickup.count).toBe(1)
    expect(d.needsAttention.filter((r) => r.reason === 'ready_waiting').map((r) => r.number)).toEqual(['2026-0020'])
    // A payment due date is set by hand on the order (an ordinary header edit) and shown here.
    expect((await t.call('PATCH', '/orders/2026-0020', { paymentDueOn: '2026-02-30', expectedVersion: t.o('2026-0020').version })).status).toBe(400)
    expect((await t.call('PATCH', '/orders/2026-0020', { paymentDueOn: '2026-11-15', expectedVersion: t.o('2026-0020').version })).status).toBe(200)
    expect((await t.call<PaymentsPageResponse>('GET', '/payments')).body.outstanding.find((r) => r.number === '2026-0020')).toMatchObject({ paymentDueOn: '2026-11-15' })
    // Paying off 2026-0006 by check removes it from both.
    await checkPost(t, 2, 'collect', { amountReceivedCents: 72000 })
    const after = (await t.call<PaymentsPageResponse>('GET', '/payments')).body
    expect(after.outstanding.map((r) => r.number)).toEqual(['2026-0020'])
    expect(after.checksInHand.map((k) => [k.id, k.status])).toEqual([[2, 'collected']])
  })
})
