// M4 production queue through the real /api/app routes on the seeded D1, plus each DB writer called directly with a
// stale version, so the SQL guard itself (not just the route's read) is proven. The trigger-level rules are in
// production-slots.test.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { Hono } from 'hono'
import { appRoutes } from '../../worker/routes/app'
import type { AppEnv } from '../../worker/auth'
import type { ApiError, DashboardResponse, OrderWriteResponse, ProductionResponse, QueueReorderResponse } from '../../shared/api'
import * as dbo from '../../worker/db/orders'
import * as dbp from '../../worker/db/production'
import { createTestD1 } from './d1'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
const OWNER = 'owner1@example.com', STAFF = 'staff@example.com'
// Seed: 2026-0003 runs in slot 1 (4 of 10 units); 2026-0017 (queue 1) and 2026-0005 (queue 2) are ready;
// 2026-0004 (50 of 50) and 2026-0019 are in quality_control; 2026-0006 and 2026-0020 production_complete; 2026-0024 cancelled.

function setup() {
  const { db, sqlite } = createTestD1()
  sqlite.exec(seed)
  sqlite.exec(`INSERT INTO users (id, email, name, role, active) VALUES (3, '${STAFF}', 'Staff', 'staff', 1)`)
  const app = new Hono<AppEnv>().route('/api/app', appRoutes())
  const call = async <T = OrderWriteResponse>(method: string, path: string, body?: unknown, email = OWNER) => {
    const res = await app.request(`http://localhost/api/app${path}`,
      { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: db, DEV_AUTH_EMAIL: email })
    return { status: res.status, body: (await res.json()) as T & Partial<ApiError> }
  }
  const one = <T>(sql: string, ...p: (string | number)[]) => sqlite.prepare(sql).get(...p) as T
  type Row = { id: number; version: number; production_status: string; state: string; production_slot: number | null; production_override_by: number | null
    production_override_reason: string | null; queue_position: number | null; units_completed: number }
  const o = (n: string) => one<Row>(`SELECT id, version, production_status, state, production_slot, production_override_by, production_override_reason,
    queue_position, units_completed FROM orders WHERE number = ?`, n)
  /** Every order row and every activity row: a refused write changes none of them. */
  const footprint = () => ({ orders: sqlite.prepare('SELECT * FROM orders ORDER BY id').all(), activity: one<{ n: number }>('SELECT COUNT(*) AS n FROM activity_log').n })
  const acts = (n: string) => (sqlite.prepare(`SELECT actor_id, action, before, after FROM activity_log WHERE entity_type = 'order' AND entity_id = ? ORDER BY id`)
    .all(o(n).id) as { actor_id: number; action: string; before: string | null; after: string | null }[])
  const move = (n: string, to: string, extra: object = {}, email = OWNER) => call('PATCH', `/orders/${n}/production`, { to, expectedVersion: o(n).version, ...extra }, email)
  const units = (n: string, unitsCompleted: unknown, expectedVersion = o(n).version) => call('PATCH', `/orders/${n}/units`, { unitsCompleted, expectedVersion })
  const production = async () => (await call<ProductionResponse>('GET', '/production')).body
  return { db, sqlite, call, one, o, footprint, acts, move, units, production }
}
type T = ReturnType<typeof setup>
const finishSlot1 = async (t: T) => expect((await t.move('2026-0003', 'quality_control')).status).toBe(200)

describe('start', () => {
  test('happy path: slot 1, version bumped, queue position cleared, one production_started row', async () => {
    const t = setup()
    await finishSlot1(t)
    const before = t.o('2026-0005')
    const res = await t.move('2026-0005', 'in_production')
    expect(res).toMatchObject({ status: 200, body: { number: '2026-0005', productionStatus: 'in_production', version: before.version + 1 } })
    expect(t.o('2026-0005')).toMatchObject({ production_status: 'in_production', production_slot: 1, queue_position: null, version: before.version + 1, production_override_by: null })
    expect(t.acts('2026-0005').slice(-1)).toEqual([{ actor_id: 1, action: 'production_started', before: '{"production_status":"ready"}', after: '{"production_status":"in_production","slot":1}' }])
  })

  test('a second start is 409 production_busy naming the running job, with nothing written', async () => {
    const t = setup()
    const before = t.footprint()
    const res = await t.move('2026-0005', 'in_production')
    expect(res).toMatchObject({ status: 409, body: { code: 'production_busy', runningJob: '2026-0003' } })
    expect(t.footprint()).toEqual(before)
  })

  test('an owner override with a reason takes slot 2 with exactly one production_override audit row', async () => {
    const t = setup()
    const res = await t.move('2026-0005', 'in_production', { override: true, reason: '  District needs it Friday ' })
    expect(res.status).toBe(200)
    expect(t.o('2026-0005')).toMatchObject({ production_slot: 2, production_override_by: 1, production_override_reason: 'District needs it Friday' })
    const rows = t.acts('2026-0005').filter((a) => ['production_override', 'production_started'].includes(a.action))
    expect(rows.map((r) => r.action).sort()).toEqual(['production_override', 'production_started'])
    expect(JSON.parse(rows.find((r) => r.action === 'production_override')!.after!)).toEqual({ reason: 'District needs it Friday', running_order_id: 3 })
    const p = await t.production()
    expect(p.current.map((j) => [j.number, j.slot, j.override])).toEqual([['2026-0003', 1, null], ['2026-0005', 2, { by: 'Owner One', reason: 'District needs it Friday' }]])
  })

  test('staff cannot override (403); a blank reason is 400; nothing written either way', async () => {
    const t = setup()
    const before = t.footprint()
    expect(await t.move('2026-0005', 'in_production', { override: true, reason: 'rush' }, STAFF)).toMatchObject({ status: 403, body: { code: 'override_requires_owner' } })
    for (const reason of [undefined, '', '   ']) {
      expect(await t.move('2026-0005', 'in_production', { override: true, reason }), String(reason)).toMatchObject({ status: 400, body: { code: 'override_requires_reason' } })
    }
    expect(t.footprint()).toEqual(before)
  })

  test('a third start is refused even for an owner: 409 no_slot_available', async () => {
    const t = setup()
    expect((await t.move('2026-0005', 'in_production', { override: true, reason: 'rush' })).status).toBe(200)
    const before = t.footprint()
    expect(await t.move('2026-0017', 'in_production', { override: true, reason: 'another rush' })).toMatchObject({ status: 409, body: { code: 'no_slot_available' } })
    expect(await t.move('2026-0017', 'in_production')).toMatchObject({ status: 409, body: { code: 'no_slot_available' } })
    expect(t.footprint()).toEqual(before)
  })

  test('override is ignored when slot 1 is free: slot 1, no audit row', async () => {
    const t = setup()
    await finishSlot1(t)
    expect((await t.move('2026-0005', 'in_production', { override: true, reason: 'rush' })).status).toBe(200)
    expect(t.o('2026-0005')).toMatchObject({ production_slot: 1, production_override_by: null, production_override_reason: null })
    expect(t.acts('2026-0005').map((a) => a.action)).not.toContain('production_override')
  })

  test('concurrent starts (two requests that both read slot 1 free): one wins, the other is 409 production_busy naming it', async () => {
    const t = setup()
    await finishSlot1(t)
    const [a, b] = await Promise.all([t.move('2026-0005', 'in_production'), t.move('2026-0017', 'in_production')])
    const winner = a.status === 200 ? '2026-0005' : '2026-0017'
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect((a.status === 409 ? a : b).body).toMatchObject({ code: 'production_busy', runningJob: winner })
    expect(t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE production_status = 'in_production'`).n).toBe(1)
    expect(t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM activity_log WHERE action = 'production_started'`).n).toBe(1)
  })

  test('refused when not ready (gate_failed), and when readiness was lost after the status said ready (the SQL GATE_OK)', async () => {
    const t = setup()
    await finishSlot1(t)
    // An awaiting order can't jump to production at all.
    expect(await t.move('2026-0011', 'in_production')).toMatchObject({ status: 409, body: { code: 'transition_not_allowed' } })
    // 2026-0017 still says ready, but prep went back to in progress and nothing re-derived it yet.
    t.sqlite.exec(`UPDATE orders SET prep_status = 'in_progress' WHERE number = '2026-0017'`)
    expect(await t.move('2026-0017', 'in_production')).toMatchObject({ status: 409, body: { code: 'gate_failed', reasons: ['preparation.in_progress'] } })
    const before = t.footprint()
    const r = t.o('2026-0017')
    expect(await dbo.applyProductionChange(t.db, { orderId: r.id, actorId: 1, from: 'ready', to: 'in_production', expectedVersion: r.version, slot: { slot: 1, overrideBy: null, reason: null } })).toBe(false)
    expect(t.footprint()).toEqual(before)
  })

  test('restart after QC re-checks readiness, in the route and in the SQL', async () => {
    const t = setup()
    await finishSlot1(t)
    // 2026-0004 is in QC; its approved PO is revoked.
    t.sqlite.exec(`UPDATE purchase_orders SET status = 'rejected' WHERE id = 5`)
    expect(await t.move('2026-0004', 'in_production')).toMatchObject({ status: 409, body: { code: 'gate_failed', reasons: ['authorization.po_not_approved'] } })
    const r = t.o('2026-0004')
    expect(await dbo.applyProductionChange(t.db, { orderId: r.id, actorId: 1, from: 'quality_control', to: 'in_production', expectedVersion: r.version, slot: { slot: 1, overrideBy: null, reason: null } })).toBe(false)
    t.sqlite.exec(`UPDATE purchase_orders SET status = 'approved' WHERE id = 5`)
    expect((await t.move('2026-0004', 'in_production')).status).toBe(200)
    expect(t.o('2026-0004')).toMatchObject({ production_status: 'in_production', production_slot: 1, units_completed: 50 })
    expect(JSON.parse(t.acts('2026-0004').at(-1)!.before!)).toEqual({ production_status: 'quality_control' })
  })
})

describe('leaving production', () => {
  test('in_production → quality_control frees the slot; the next start takes slot 1', async () => {
    const t = setup()
    await finishSlot1(t)
    expect(t.o('2026-0003')).toMatchObject({ production_status: 'quality_control', production_slot: null })
    expect(t.acts('2026-0003').at(-1)).toMatchObject({ action: 'production_status_changed', after: '{"production_status":"quality_control"}' })
    expect((await t.move('2026-0005', 'in_production')).status).toBe(200)
    expect(t.o('2026-0005').production_slot).toBe(1)
  })

  test('a slot-2 job is never moved into slot 1; when it leaves, its override is cleared with the slot', async () => {
    const t = setup()
    await t.move('2026-0005', 'in_production', { override: true, reason: 'rush' })
    await finishSlot1(t)
    expect(t.o('2026-0005')).toMatchObject({ production_slot: 2, production_override_reason: 'rush' })
    expect((await t.move('2026-0017', 'in_production')).status).toBe(200)
    expect(t.o('2026-0017').production_slot).toBe(1)
    expect((await t.move('2026-0005', 'quality_control')).status).toBe(200)
    expect(t.o('2026-0005')).toMatchObject({ production_status: 'quality_control', production_slot: null, production_override_by: null, production_override_reason: null })
  })

  test('quality_control → production_complete; skipping QC is refused', async () => {
    const t = setup()
    expect(await t.move('2026-0003', 'production_complete')).toMatchObject({ status: 409, body: { code: 'transition_not_allowed' } })
    expect((await t.move('2026-0004', 'production_complete')).status).toBe(200)
    expect(t.o('2026-0004')).toMatchObject({ production_status: 'production_complete', state: 'active' })
  })

  test('pause goes to readiness’s preProductionStatus, never a fixed ready, and frees the slot', async () => {
    const t = setup()
    t.sqlite.exec(`UPDATE purchase_orders SET status = 'rejected' WHERE id = 3`) // 2026-0003's PO, mid-run
    expect(await t.move('2026-0003', 'ready')).toMatchObject({ status: 409, body: { code: 'gate_failed', reasons: ['authorization.po_not_approved'] } })
    expect((await t.move('2026-0003', 'awaiting_authorization')).status).toBe(200)
    expect(t.o('2026-0003')).toMatchObject({ production_status: 'awaiting_authorization', production_slot: null, units_completed: 4 })
  })

  test('a production row carries readiness’s preProductionStatus (what Pause sends) and startedAt', async () => {
    const t = setup()
    const row = async () => (await t.production()).current.find((j) => j.number === '2026-0003')!
    const detail = async () => (await t.call<{ readiness: { preProductionStatus: string } }>('GET', '/orders/2026-0003')).body.readiness.preProductionStatus
    expect((await row()).preProductionStatus).toBe(await detail())
    expect((await row()).preProductionStatus).toBe('ready')
    t.sqlite.exec(`UPDATE purchase_orders SET status = 'rejected' WHERE id = 3`)
    const stale = await row() // read after the change, so it is current
    expect(stale.preProductionStatus).toBe('awaiting_authorization')
    expect(stale.preProductionStatus).toBe(await detail())
    t.sqlite.exec(`UPDATE purchase_orders SET status = 'approved' WHERE id = 3`) // readiness moved back: the old target is now wrong
    expect(await t.move('2026-0003', stale.preProductionStatus, { expectedVersion: stale.version })).toMatchObject({ status: 409 })
    await finishSlot1(t)
    expect((await t.move('2026-0017', 'in_production')).status).toBe(200)
    expect((await t.production()).current[0]).toMatchObject({ number: '2026-0017', startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) })
  })

  test('cancel releases the slot (the one cancel path); a slot-2 job too', async () => {
    const t = setup()
    await t.move('2026-0005', 'in_production', { override: true, reason: 'rush' })
    for (const n of ['2026-0005', '2026-0003']) {
      expect((await t.call('POST', `/orders/${n}/cancel`, { reason: 'Customer cancelled', expectedVersion: t.o(n).version })).status).toBe(200)
      expect(t.o(n)).toMatchObject({ state: 'cancelled', production_status: 'ready', production_slot: null, production_override_by: null, production_override_reason: null })
    }
    expect((await t.move('2026-0017', 'in_production')).status).toBe(200)
    expect(t.o('2026-0017').production_slot).toBe(1)
  })
})

describe('units completed', () => {
  test('recorded and corrected up or down while running or in QC, each with an activity row', async () => {
    const t = setup()
    const v = t.o('2026-0003').version
    expect(await t.units('2026-0003', 7)).toMatchObject({ status: 200, body: { version: v + 1 } })
    expect((await t.units('2026-0003', 2)).status).toBe(200)
    expect((await t.units('2026-0003', 10)).status).toBe(200)
    expect(t.o('2026-0003').units_completed).toBe(10)
    expect(t.acts('2026-0003').filter((a) => a.action === 'units_completed_changed').map((a) => [a.before, a.after])).toEqual([
      ['{"units_completed":4}', '{"units_completed":7}'], ['{"units_completed":7}', '{"units_completed":2}'], ['{"units_completed":2}', '{"units_completed":10}']])
    expect((await t.units('2026-0004', 49)).status).toBe(200)
  })

  test('outside 0..total quantity, not an integer, or not running/QC: refused with nothing written', async () => {
    const t = setup()
    const before = t.footprint()
    for (const bad of [11, -1, 1.5, '3', null]) expect((await t.units('2026-0003', bad)).status, String(bad)).toBe(400)
    expect((await t.units('2026-0003', 11)).body.code).toBe('invalid_units_completed')
    for (const n of ['2026-0005', '2026-0006']) expect(await t.units(n, 1), n).toMatchObject({ status: 409, body: { code: 'units_not_editable' } })
    expect(t.footprint()).toEqual(before)
  })

  test('the SQL re-checks the cap and the status', async () => {
    const t = setup()
    const before = t.footprint()
    const r = t.o('2026-0003')
    expect(await dbp.setUnitsCompleted(t.db, { orderId: r.id, version: r.version, actorId: 1, from: 4, to: 11 })).toBeNull()
    const ready = t.o('2026-0005')
    expect(await dbp.setUnitsCompleted(t.db, { orderId: ready.id, version: ready.version, actorId: 1, from: 0, to: 1 })).toBeNull()
    expect(t.footprint()).toEqual(before)
  })
})

describe('queue', () => {
  test('Production page: current, ready in queue order, completed; with the job details', async () => {
    const t = setup()
    const p = await t.production()
    expect(p.current).toEqual([expect.objectContaining({
      number: '2026-0003', slot: 1, override: null, unitsCompleted: 4, totalQuantity: 10, product: { first: 'Tumbler', lines: 1 }, methods: ['laser_engrave'],
      notesCount: 1, latestNote: expect.objectContaining({ body: 'Customer prefers pickup after 3pm.' }), customerName: 'Cedar Hollow ISD',
    })])
    expect(p.readyToStart.map((j) => [j.number, j.queuePosition])).toEqual([['2026-0017', 1], ['2026-0005', 2]])
    expect(p.completed.map((j) => j.number).sort()).toEqual(['2026-0004', '2026-0006', '2026-0019', '2026-0020'])
  })

  test('reorder: positions written in one batch with one activity row, no version bumped', async () => {
    const t = setup()
    const versions = [t.o('2026-0005').version, t.o('2026-0017').version]
    const res = await t.call<QueueReorderResponse>('POST', '/production/queue', { seen: ['2026-0017', '2026-0005'], orderNumbers: ['2026-0005', '2026-0017'] })
    expect(res).toMatchObject({ status: 200, body: { readyToStart: ['2026-0005', '2026-0017'] } })
    expect([t.o('2026-0005').queue_position, t.o('2026-0017').queue_position]).toEqual([1, 2])
    expect([t.o('2026-0005').version, t.o('2026-0017').version]).toEqual(versions)
    expect(t.one('SELECT actor_id, entity_type, action, before, after FROM activity_log ORDER BY id DESC LIMIT 1')).toEqual({
      actor_id: 1, entity_type: 'production_queue', action: 'queue_reordered',
      before: '{"order_numbers":["2026-0017","2026-0005"]}', after: '{"order_numbers":["2026-0005","2026-0017"]}' })
    expect((await t.production()).readyToStart.map((j) => j.number)).toEqual(['2026-0005', '2026-0017'])
  })

  test('a stale queue (someone reordered, or an order became ready) is 409 with nothing written; a non-permutation is 400', async () => {
    const t = setup()
    await t.call('POST', '/production/queue', { seen: ['2026-0017', '2026-0005'], orderNumbers: ['2026-0005', '2026-0017'] })
    let before = t.footprint()
    expect(await t.call('POST', '/production/queue', { seen: ['2026-0017', '2026-0005'], orderNumbers: ['2026-0005', '2026-0017'] }))
      .toMatchObject({ status: 409, body: { code: 'conflict_retry' } })
    for (const orderNumbers of [['2026-0005'], ['2026-0005', '2026-0005'], ['2026-0005', '2026-0004']]) {
      expect((await t.call('POST', '/production/queue', { seen: ['2026-0005', '2026-0017'], orderNumbers })).status).toBe(400)
    }
    expect(t.footprint()).toEqual(before)
    // 2026-0004 drops back to ready (pause after a restart) and is not in the list the page saw.
    await finishSlot1(t)
    await t.move('2026-0004', 'in_production')
    await t.move('2026-0004', 'ready')
    before = t.footprint()
    expect((await t.call('POST', '/production/queue', { seen: ['2026-0005', '2026-0017'], orderNumbers: ['2026-0017', '2026-0005'] })).status).toBe(409)
    expect(t.footprint()).toEqual(before)
  })

  test('the SQL guard alone: reorderQueue with a stale `seen` writes nothing', async () => {
    const t = setup()
    const before = t.footprint()
    expect(await dbp.reorderQueue(t.db, { actorId: 1, seen: ['2026-0005', '2026-0017'], next: ['2026-0017', '2026-0005'] })).toBe(false)
    expect(await dbp.reorderQueue(t.db, { actorId: 1, seen: ['2026-0017'], next: ['2026-0017'] })).toBe(false)
    expect(t.footprint()).toEqual(before)
    expect(await dbp.reorderQueue(t.db, { actorId: 1, seen: ['2026-0017', '2026-0005'], next: ['2026-0005', '2026-0017'] })).toBe(true)
  })
})

describe('stale expectedVersion on every write: 409, nothing written', () => {
  test('through the routes', async () => {
    const t = setup()
    await finishSlot1(t)
    // Someone else's change bumps each version after the page loaded.
    const seen = Object.fromEntries(['2026-0003', '2026-0004', '2026-0005'].map((n) => [n, t.o(n).version]))
    t.sqlite.exec(`UPDATE orders SET version = version + 1 WHERE number IN ('2026-0003', '2026-0004', '2026-0005')`)
    const stale = (n: string) => seen[n]!
    const before = t.footprint()
    for (const [n, body] of [
      ['2026-0005', { to: 'in_production' }], ['2026-0005', { to: 'in_production', override: true, reason: 'x' }],
      ['2026-0003', { to: 'production_complete' }], ['2026-0004', { to: 'in_production' }],
    ] as const) {
      expect(await t.call('PATCH', `/orders/${n}/production`, { ...body, expectedVersion: stale(n) }), n).toMatchObject({ status: 409, body: { code: 'conflict_retry' } })
    }
    expect(await t.units('2026-0003', 1, stale('2026-0003'))).toMatchObject({ status: 409, body: { code: 'conflict_retry' } })
    expect(t.footprint()).toEqual(before)
  })

  test('each DB writer called directly with a stale version changes nothing', async () => {
    const t = setup()
    t.sqlite.exec(`UPDATE orders SET version = version + 1 WHERE number IN ('2026-0003', '2026-0004', '2026-0005')`) // so version - 1 is a real, stale version
    const r3 = t.o('2026-0003'), r4 = t.o('2026-0004')
    const before = t.footprint()
    const change = (r: { id: number; version: number }, from: string, to: string, slot?: { slot: 1 | 2; overrideBy: number | null; reason: string | null }) =>
      dbo.applyProductionChange(t.db, { orderId: r.id, actorId: 1, from: from as never, to: to as never, expectedVersion: r.version - 1, slot })
    expect(await change(r3, 'in_production', 'quality_control')).toBe(false)
    expect(await change(r3, 'in_production', 'ready')).toBe(false)
    expect(await change(r4, 'quality_control', 'production_complete')).toBe(false)
    expect(await dbp.setUnitsCompleted(t.db, { orderId: r3.id, version: r3.version - 1, actorId: 1, from: 4, to: 5 })).toBeNull()
    expect(await dbo.cancelOrder(t.db, { orderId: r3.id, version: r3.version - 1, actorId: 1, reason: 'x', productionFrom: 'in_production', productionTo: 'ready' })).toBeNull()
    expect(t.footprint()).toEqual(before)
    // And a start: slot 1 freed by hand, the stale start still matches nothing.
    t.sqlite.exec(`UPDATE orders SET production_status = 'quality_control', production_slot = NULL WHERE id = 3`)
    const r5 = t.o('2026-0005')
    const mid = t.footprint()
    expect(await change(r5, 'ready', 'in_production', { slot: 1, overrideBy: null, reason: null })).toBe(false)
    expect(await change(r4, 'quality_control', 'in_production', { slot: 1, overrideBy: null, reason: null })).toBe(false)
    expect(t.footprint()).toEqual(mid)
  })
})

describe('interleavings on one order: whichever batch lands second changes nothing (Codex review of fcdbb90)', () => {
  // D1 runs each batch atomically, so a race between two writes is one of the two orders below. Both carry the version
  // their caller read; the second must match nothing and log nothing.
  const slot1 = { slot: 1 as const, overrideBy: null, reason: null }
  test('start vs cancel, in both orders', async () => {
    for (const first of ['cancel', 'start'] as const) {
      const t = setup()
      t.sqlite.exec(`UPDATE orders SET production_status = 'quality_control', production_slot = NULL WHERE id = 3`) // free slot 1
      const r = t.o('2026-0005')
      const start = () => dbo.applyProductionChange(t.db, { orderId: r.id, actorId: 1, from: 'ready', to: 'in_production', expectedVersion: r.version, slot: slot1 })
      const cancel = () => dbo.cancelOrder(t.db, { orderId: r.id, version: r.version, actorId: 1, reason: 'x', productionFrom: 'ready', productionTo: 'ready' })
      if (first === 'cancel') { expect(await cancel()).not.toBeNull() } else { expect(await start()).toBe(true) }
      const mid = t.footprint()
      if (first === 'cancel') { expect(await start()).toBe(false) } else { expect(await cancel()).toBeNull() }
      expect(t.footprint(), first).toEqual(mid)
    }
  })
  test('pause vs send to QC on the running job, in both orders', async () => {
    for (const first of ['pause', 'qc'] as const) {
      const t = setup()
      const r = t.o('2026-0003')
      const pause = () => dbo.applyProductionChange(t.db, { orderId: r.id, actorId: 1, from: 'in_production', to: 'ready', expectedVersion: r.version })
      const qc = () => dbo.applyProductionChange(t.db, { orderId: r.id, actorId: 1, from: 'in_production', to: 'quality_control', expectedVersion: r.version })
      expect(await (first === 'pause' ? pause() : qc())).toBe(true)
      const mid = t.footprint()
      expect(await (first === 'pause' ? qc() : pause())).toBe(false)
      expect(t.footprint(), first).toEqual(mid)
      expect(t.o('2026-0003').production_slot).toBeNull()
    }
  })
})

describe('dashboard v2', () => {
  test('current job, upcoming queue and the action-required groups', async () => {
    const t = setup()
    const d = (await t.call<DashboardResponse>('GET', '/dashboard')).body
    expect(d.currentJobs.map((j) => [j.number, j.slot, j.unitsCompleted])).toEqual([['2026-0003', 1, 4]])
    expect(d.upcoming.map((j) => j.number)).toEqual(['2026-0017', '2026-0005'])
    const nums = (rows: { number: string }[]) => rows.map((r) => r.number).sort()
    expect(nums(d.actionRequired.quotes)).toEqual(['2026-0014', '2026-0022', '2026-0023', '2026-0025'])
    expect(nums(d.actionRequired.missingArtwork)).toEqual(['2026-0008', '2026-0009', '2026-0022', '2026-0023', '2026-0025'])
    expect(nums(d.actionRequired.pendingPos)).toEqual(['2026-0010', '2026-0011', '2026-0012', '2026-0013', '2026-0014'])
    expect(nums(d.actionRequired.materialsAwaiting)).toEqual(['2026-0016'])
    expect(d.actionRequired.pendingPos.find((r) => r.number === '2026-0013')).toMatchObject({ poStatus: 'rejected' })
    expect([d.actionRequired.awaitingPickup, d.actionRequired.checksToCollect]).toEqual([[], []])
    // Running (3), QC (4, 19) and cancelled (24) orders with a rejected PO, an unreceived purchase and changes-requested
    // artwork still stay out: only pre-production orders need these actions (Codex review of fcdbb90).
    for (const id of [3, 4, 19, 24]) {
      t.sqlite.exec(`UPDATE orders SET po_required = 1 WHERE id = ${id}`)
      t.sqlite.exec(`INSERT INTO purchase_orders (order_id, po_number, status) VALUES (${id}, 'R-${id}', 'rejected')`)
      t.sqlite.exec(`INSERT INTO order_purchases (order_id, supplier_id, description, quantity, status, ordered_on) VALUES (${id}, 1, 'late', 5, 'ordered', '2026-10-30')`)
    }
    t.sqlite.exec(`UPDATE artwork SET approval_status = 'changes_requested' WHERE order_id IN (3, 4, 19, 24)`)
    expect((await t.call<DashboardResponse>('GET', '/dashboard')).body.actionRequired).toEqual(d.actionRequired)
    // Materials: once everything ordered has arrived it leaves the group.
    t.sqlite.exec(`INSERT INTO purchase_receipts (purchase_id, quantity, received_on) VALUES (2, 10, date('now'))`)
    expect((await t.call<DashboardResponse>('GET', '/dashboard')).body.actionRequired.materialsAwaiting).toEqual([])
  })
})
