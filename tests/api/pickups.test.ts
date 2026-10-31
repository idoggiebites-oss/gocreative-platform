// M5 pickups through the real /api/app routes on the seeded D1, each DB writer called directly with a stale version, the
// pickup-vs-payment interleaving in both orders, and the migration 0006 triggers hit with direct SQL.
// Seed: see tests/api/m5.ts.
import { describe, expect, test } from 'vitest'
import type { PickupResponse } from '../../shared/api'
import { NOTIFICATION_METHODS } from '../../shared/enums'
import * as dbk from '../../worker/db/pickups'
import * as dbm from '../../worker/db/payments'
import { setup, STAFF } from './m5'

describe('reading the pickup', () => {
  test('a notified, partly paid pay-at-pickup order: notified, balance owed, and the override warning', async () => {
    const t = setup()
    const r = await t.call<PickupResponse>('GET', '/orders/2026-0020/pickup')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      paymentTerms: 'due_at_pickup', releaseNeedsOverride: true, version: t.o('2026-0020').version,
      pickup: { fulfilmentStatus: 'customer_notified', notificationMethod: 'phone', pickedUpOn: null, releaseOverride: null },
      balance: { agreedCents: 230300, receivedCents: 50000, outstandingCents: 180300, creditCents: 0, status: 'partially_paid' },
    })
    // An unfinished order has nothing to pick up; a district order never needs the override.
    expect((await t.call<PickupResponse>('GET', '/orders/2026-0019/pickup')).body).toMatchObject({ pickup: { fulfilmentStatus: 'not_ready', readyOn: null }, releaseNeedsOverride: false })
    expect((await t.call<PickupResponse>('GET', '/orders/2026-0006/pickup')).body).toMatchObject({ pickup: { fulfilmentStatus: 'picked_up', collectedByName: 'Sam Okafor' }, releaseNeedsOverride: false })
  })
})

describe('notify and collect', () => {
  test('only a production_complete order: refused before, nothing written; the trigger refuses direct SQL too', async () => {
    const t = setup()
    const before = t.footprint()
    expect(await t.notify('2026-0019')).toMatchObject({ status: 409, body: { code: 'pickup_not_ready' } })
    expect(await t.collect('2026-0019')).toMatchObject({ status: 409, body: { code: 'pickup_not_ready' } })
    expect(t.footprint()).toEqual(before)
    expect(() => t.sqlite.exec(`INSERT INTO pickups (order_id, ready_on) VALUES (19, '2026-10-30')`)).toThrow(/pickup_not_ready/)
    // The writers' own WHERE refuses too, even at the right version.
    expect(await dbk.notifyPickup(t.db, { orderId: 19, version: t.o('2026-0019').version, actorId: 1, readyOn: '2026-10-30', notifiedOn: '2026-10-30', method: 'phone', notes: null })).toBe(false)
    expect(t.footprint()).toEqual(before)
  })

  test('a district order: notify, then collect unpaid; picked up = fulfilled, still active (unpaid), one row per order', async () => {
    const t = setup()
    await t.finish('2026-0004')
    const v = t.o('2026-0004').version
    expect(await t.notify('2026-0004', { method: 'email', notifiedOn: '2026-10-30', notes: 'Left a voicemail too' }, STAFF)).toMatchObject({ status: 200, body: { version: v + 1 } })
    expect(t.pickup('2026-0004')).toMatchObject({ notified_on: '2026-10-30', notification_method: 'email', picked_up_on: null, notes: 'Left a voicemail too' })
    const res = await t.collect('2026-0004', { pickedUpOn: '2026-10-31' }, STAFF)
    expect(res).toMatchObject({ status: 200, body: { state: 'active', version: v + 2 } })
    expect(t.pickup('2026-0004')).toMatchObject({ picked_up_on: '2026-10-31', collected_by_name: 'Jo Customer', completed_by: 3, release_override_by: null, notes: 'Left a voicemail too' })
    expect(t.acts('2026-0004').slice(-2).map((a) => a.action)).toEqual(['pickup_notified', 'pickup_collected'])
    expect((await t.call<PickupResponse>('GET', '/orders/2026-0004/pickup')).body.pickup).toMatchObject({ fulfilmentStatus: 'picked_up', completedBy: 'Staff' })
    expect(t.one<{ n: number }>('SELECT COUNT(*) AS n FROM pickups WHERE order_id = 4').n).toBe(1)
    // Picked up is final: a second collect or notify is refused, and nothing changes.
    const before = t.footprint()
    expect(await t.collect('2026-0004')).toMatchObject({ status: 409, body: { code: 'pickup_recorded' } })
    expect(await t.notify('2026-0004')).toMatchObject({ status: 409, body: { code: 'pickup_recorded' } })
    expect(t.footprint()).toEqual(before)
  })

  test('unpaid pay-at-pickup: refused without override; staff 403; owner needs a reason; the override writes exactly one audit row', async () => {
    const t = setup()
    const before = t.footprint()
    expect(await t.collect('2026-0020')).toMatchObject({ status: 409, body: { code: 'payment_required' } })
    expect(await t.collect('2026-0020', { override: true, reason: 'Regular customer' }, STAFF)).toMatchObject({ status: 403, body: { code: 'override_requires_owner' } })
    expect(await t.collect('2026-0020', { override: true, reason: '   ' })).toMatchObject({ status: 400, body: { code: 'override_requires_reason' } })
    expect(t.footprint()).toEqual(before)
    const res = await t.collect('2026-0020', { override: true, reason: '  Pays Friday, known customer ' })
    expect(res).toMatchObject({ status: 200, body: { state: 'active' } })
    expect(t.pickup('2026-0020')).toMatchObject({ release_override_by: 1, release_override_reason: 'Pays Friday, known customer', completed_by: 1 })
    const audit = t.acts('2026-0020', 'pickup_release_override')
    expect(audit).toEqual([{ actor_id: 1, action: 'pickup_release_override', before: null, after: JSON.stringify({ reason: 'Pays Friday, known customer' }) }])
    expect((await t.call<PickupResponse>('GET', '/orders/2026-0020/pickup')).body.pickup.releaseOverride).toEqual({ by: 'Owner One', reason: 'Pays Friday, known customer' })
  })

  test('an override sent for a paid order is not used: no override stored, no audit row', async () => {
    const t = setup()
    expect((await t.pay('2026-0020', 180300)).status).toBe(201)
    expect((await t.collect('2026-0020', { override: true, reason: 'not needed' }, STAFF)).status).toBe(200)
    expect(t.pickup('2026-0020')).toMatchObject({ release_override_by: null, release_override_reason: null })
    expect(t.acts('2026-0020', 'pickup_release_override')).toEqual([])
  })
})

describe('closing the order (picked up AND paid)', () => {
  test('payment first, then pickup: the pickup closes the order in the same write, with one order_closed row', async () => {
    const t = setup()
    expect((await t.pay('2026-0020', 180300)).body).toMatchObject({ state: 'active' })
    const res = await t.collect('2026-0020')
    expect(res).toMatchObject({ status: 200, body: { state: 'closed' } })
    expect(t.acts('2026-0020').slice(-2)).toEqual([
      expect.objectContaining({ action: 'pickup_collected' }),
      { actor_id: 1, action: 'order_closed', before: '{"state":"active"}', after: '{"state":"closed","reason":"picked_up"}' },
    ])
  })

  test('pickup first, then payment: the final payment closes it (a partial one does not)', async () => {
    const t = setup()
    expect((await t.pay('2026-0006', 70000)).body).toMatchObject({ state: 'active' })
    expect(t.acts('2026-0006', 'order_closed')).toEqual([])
    expect((await t.pay('2026-0006', 2000)).body).toMatchObject({ state: 'closed' })
    expect(t.acts('2026-0006', 'order_closed')).toEqual([{ actor_id: 1, action: 'order_closed', before: '{"state":"active"}', after: '{"state":"closed","reason":"payment_recorded"}' }])
    // A closed order takes no more pickup writes.
    expect(await t.notify('2026-0006')).toMatchObject({ status: 409, body: { code: 'order_not_active' } })
  })
})

describe('the SQL guards', () => {
  test('each writer called directly with a stale version changes and logs nothing', async () => {
    const t = setup()
    const v = t.o('2026-0020').version
    const before = t.footprint()
    const base = { orderId: 20, version: v - 1, actorId: 1, readyOn: '2026-10-30' }
    expect(await dbk.notifyPickup(t.db, { ...base, notifiedOn: '2026-10-31', method: 'email', notes: 'x' })).toBe(false)
    expect(await dbk.collectPickup(t.db, { ...base, pickedUpOn: '2026-10-31', collectedByName: 'X', notes: null, override: { by: 1, reason: 'r' } })).toBe(false)
    expect(t.footprint()).toEqual(before)
    // A pickup row that doesn't exist yet isn't created by a stale write either.
    await t.finish('2026-0019')
    const before19 = t.footprint()
    const v19 = t.o('2026-0019').version
    expect(await dbk.notifyPickup(t.db, { ...base, orderId: 19, version: v19 - 1, notifiedOn: '2026-10-31', method: 'email', notes: null })).toBe(false)
    expect(await dbk.collectPickup(t.db, { ...base, orderId: 19, version: v19 - 1, pickedUpOn: '2026-10-31', collectedByName: 'X', notes: null, override: null })).toBe(false)
    expect(t.footprint()).toEqual(before19)
  })

  test('pickup vs payment from the same version, both orders: the second changes nothing', async () => {
    for (const first of ['pickup', 'payment'] as const) {
      const t = setup()
      await t.finish('2026-0004') // district: collectable unpaid
      const v = t.o('2026-0004').version
      const pickup = () => dbk.collectPickup(t.db, { orderId: 4, version: v, actorId: 1, readyOn: '2026-10-30', pickedUpOn: '2026-10-31', collectedByName: 'X', notes: null, override: null })
      const payment = () => dbm.recordPayment(t.db, { orderId: 4, version: v, actorId: 1, amountCents: 73000, method: 'check', paidOn: '2026-10-31', notes: null, requestId: `r-${first}` })
      const [a, b] = first === 'pickup' ? [pickup, payment] : [payment, pickup]
      expect(await a()).toBeTruthy()
      const after = t.footprint()
      expect(await b()).toBeFalsy()
      expect(t.footprint(), first).toEqual(after)
      // Neither alone both picks up and pays, so the order stays active.
      expect(t.o('2026-0004').state).toBe('active')
    }
  })

  test('one pickup per order, REPLACE included; identity fixed through every rowid alias; final once picked up; never deleted', () => {
    const t = setup()
    const before = t.footprint()
    for (const verb of ['INSERT', 'INSERT OR REPLACE', 'REPLACE']) {
      expect(() => t.sqlite.exec(`${verb} INTO pickups (order_id, ready_on) VALUES (20, '2026-10-30')`), verb).toThrow(/pickup_exists/)
    }
    const id20 = (t.pickup('2026-0020') as { id: number }).id
    expect(() => t.sqlite.exec(`INSERT OR REPLACE INTO pickups (id, order_id, ready_on) VALUES (${id20}, 6, '2026-10-30')`)).toThrow(/pickup_exists/)
    for (const alias of ['id', 'rowid', 'oid', '_rowid_']) expect(() => t.sqlite.exec(`UPDATE pickups SET ${alias} = 999 WHERE order_id = 20`), alias).toThrow(/pickup_fixed/)
    expect(() => t.sqlite.exec(`UPDATE OR REPLACE pickups SET order_id = 6 WHERE order_id = 20`)).toThrow(/pickup_fixed/)
    expect(() => t.sqlite.exec(`UPDATE pickups SET ready_on = '2026-01-01' WHERE order_id = 20`)).toThrow(/pickup_fixed/)
    expect(() => t.sqlite.exec(`UPDATE pickups SET notes = 'edit' WHERE order_id = 6`)).toThrow(/pickup_recorded/)
    expect(() => t.sqlite.exec(`DELETE FROM pickups WHERE order_id = 20`)).toThrow(/never deleted/)
    expect(t.footprint()).toEqual(before)
  })

  test('the unpaid-release rule and its audit can’t be bypassed with direct SQL', () => {
    const t = setup()
    const set = (cols: string) => `UPDATE pickups SET picked_up_on = '2026-10-31', collected_by_name = 'X', completed_by = 1${cols} WHERE order_id = 20`
    expect(() => t.sqlite.exec(set(''))).toThrow(/payment_required/)
    expect(() => t.sqlite.exec(set(`, release_override_by = 3, release_override_reason = 'staff'`))).toThrow(/release_override_invalid/)
    expect(() => t.sqlite.exec(set(`, release_override_by = 1`))).toThrow(/CHECK constraint failed/)
    expect(() => t.sqlite.exec(set(`, release_override_by = 1, release_override_reason = '  '`))).toThrow(/CHECK constraint failed/)
    t.sqlite.exec(`UPDATE users SET active = 0 WHERE id = 2`)
    expect(() => t.sqlite.exec(set(`, release_override_by = 2, release_override_reason = 'inactive owner'`))).toThrow(/release_override_invalid/)
    expect(t.acts('2026-0020', 'pickup_release_override')).toEqual([])
    // An override without a pickup is refused; with one, the database writes its audit row.
    expect(() => t.sqlite.exec(`UPDATE pickups SET release_override_by = 1, release_override_reason = 'early' WHERE order_id = 20`)).toThrow(/CHECK constraint failed/)
    t.sqlite.exec(set(`, release_override_by = 1, release_override_reason = 'direct'`))
    expect(t.acts('2026-0020', 'pickup_release_override')).toHaveLength(1)
    // A district (pay after pickup) is released unpaid without an override, as is a fully paid pay-at-pickup order.
    t.sqlite.exec(`UPDATE orders SET production_status = 'production_complete' WHERE id = 19`)
    t.sqlite.exec(`INSERT INTO payments (order_id, amount_cents, method, paid_on, recorded_by, request_id) VALUES (19, 156600, 'cash', '2026-10-30', 1, 'full')`)
    t.sqlite.exec(`INSERT INTO pickups (order_id, ready_on, picked_up_on, collected_by_name, completed_by) VALUES (19, '2026-10-30', '2026-10-31', 'X', 1)`)
    // …but a void (not counted) leaves it owing again: the same insert on an unpaid order is refused.
    t.sqlite.exec(`UPDATE orders SET production_status = 'production_complete' WHERE id = 4`)
    t.sqlite.exec(`UPDATE orders SET payment_terms = 'due_at_pickup' WHERE id = 4`)
    t.sqlite.exec(`INSERT INTO payments (order_id, amount_cents, method, paid_on, recorded_by, request_id) VALUES (4, 73000, 'cash', '2026-10-30', 1, 'void-me')`)
    t.sqlite.exec(`UPDATE payments SET voided_at = 'now', voided_by = 1, void_reason = 'bounced' WHERE request_id = 'void-me'`)
    expect(() => t.sqlite.exec(`INSERT INTO pickups (order_id, ready_on, picked_up_on, collected_by_name, completed_by) VALUES (4, '2026-10-30', '2026-10-31', 'X', 1)`)).toThrow(/payment_required/)
  })

  test('the notification and pickup columns hold their CHECKs', () => {
    const t = setup()
    const tableSql = t.one<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'pickups'`).sql
    expect([...tableSql.match(/notification_method IN \(([^)]*)\)/)![1].matchAll(/'([^']*)'/g)].map((m) => m[1])).toEqual([...NOTIFICATION_METHODS])
    expect(() => t.sqlite.exec(`UPDATE pickups SET notified_on = '2026-02-30', notification_method = 'phone' WHERE order_id = 20`)).toThrow(/CHECK constraint failed/)
    expect(() => t.sqlite.exec(`UPDATE pickups SET notified_on = '2026-10-30', notification_method = NULL WHERE order_id = 20`)).toThrow(/CHECK constraint failed/)
    expect(() => t.sqlite.exec(`UPDATE pickups SET notification_method = 'pigeon' WHERE order_id = 20`)).toThrow(/CHECK constraint failed/)
  })
})
