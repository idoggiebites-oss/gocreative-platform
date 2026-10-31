import { describe, expect, test } from 'vitest'
import type { OrderDetailResponse, OrderWriteResponse, PurchasesResponse, SupplierResponse, SuppliersResponse, UploadResponse } from '../../shared/api'
import { ACTIVITY_ACTIONS } from '../../shared/api'
import { businessToday } from '../../shared/businessDate'
import { recordReceipt } from '../../worker/db/purchasing'
import { setupUploads } from './r2'

// Seed order 16 (2026-0016): authorized, quote accepted, artwork approved, prep not_started, materials required.
// Purchases: 1 cancelled, 2 ordered 40 with 30 received, 3 not_ordered 10. So it is awaiting_materials.
const N = '2026-0016'

function setup() {
  const t = setupUploads()
  const footprint = () => ({
    purchases: t.count('SELECT COUNT(*) AS n FROM order_purchases'), receipts: t.count('SELECT COUNT(*) AS n FROM purchase_receipts'),
    suppliers: t.count('SELECT COUNT(*) AS n FROM suppliers'), activity: t.count('SELECT COUNT(*) AS n FROM activity_log'),
    purchaseRows: t.sqlite.prepare('SELECT * FROM order_purchases ORDER BY id').all(),
  })
  const v = (n = N) => t.order(n).version
  const call = async <T = OrderWriteResponse>(method: string, path: string, body?: unknown) => {
    const res = await t.json(method, path, body)
    return { status: res.status, body: (await res.json()) as T & { code?: string } }
  }
  const purchases = async (n = N) => (await call<PurchasesResponse>('GET', `/orders/${n}/purchases`)).body.purchases
  const materials = async (n = N) => (await call<OrderDetailResponse>('GET', `/orders/${n}`)).body.readiness.items.find((i) => i.key === 'materials')
  const lastActions = (n: string, k: number) => t.activity(t.order(n).id).slice(-k).map((r) => r.action)
  return { ...t, footprint, v, call, purchases, materials, lastActions }
}

describe('suppliers', () => {
  test('JDS is the default; a new supplier is added with an activity row; a duplicate name in any case is 409', async () => {
    const t = setup()
    expect((await t.call<SuppliersResponse>('GET', '/suppliers')).body.suppliers).toEqual([{ id: 1, name: 'JDS', isDefault: true }])
    const res = await t.call<SupplierResponse>('POST', '/suppliers', { name: '  SanMar ' })
    expect([res.status, res.body.supplier]).toEqual([201, { id: 2, name: 'SanMar', isDefault: false }])
    expect(t.one('SELECT entity_type, entity_id, action FROM activity_log ORDER BY id DESC LIMIT 1')).toEqual({ entity_type: 'supplier', entity_id: 2, action: 'supplier_created' })
    const before = t.footprint()
    for (const name of ['sanmar', 'SANMAR', 'jds']) {
      const dup = await t.call('POST', '/suppliers', { name })
      expect([dup.status, dup.body.code], name).toEqual([409, 'supplier_exists'])
    }
    expect((await t.call('POST', '/suppliers', { name: '   ' })).status).toBe(400)
    expect((await t.call('POST', '/suppliers', { name: 'x'.repeat(101) })).status).toBe(400)
    expect(t.footprint()).toEqual(before)
  })
})

describe('create', () => {
  test('a purchase is created not_ordered with the default supplier when none is named, logged, and bumps the version', async () => {
    const t = setup()
    const o = t.order(N)
    const res = await t.call<UploadResponse>('POST', `/orders/${N}/purchases`,
      { description: 'Thread, black', quantity: 4, estimatedUnitCostCents: 899, expectedOn: '2026-11-05', expectedVersion: o.version })
    expect(res.status).toBe(201)
    expect(res.body.version).toBe(o.version + 1)
    expect(t.one('SELECT order_id, supplier_id, description, quantity, estimated_unit_cost_cents, status, expected_on, created_by FROM order_purchases WHERE id = ?', res.body.id))
      .toEqual({ order_id: o.id, supplier_id: 1, description: 'Thread, black', quantity: 4, estimated_unit_cost_cents: 899, status: 'not_ordered', expected_on: '2026-11-05', created_by: 1 })
    const row = t.activity(o.id).at(-1)!
    expect([row.action, JSON.parse(row.after!)]).toEqual(['purchase_created', { purchase_status: 'not_ordered', supplier_name: 'JDS', description: 'Thread, black', quantity: 4 }])
    const p = (await t.purchases()).find((x) => x.id === res.body.id)!
    expect(p).toMatchObject({ supplierName: 'JDS', status: 'not_ordered', receivedQuantity: 0, estimatedTotalCents: 3596, actualTotalCents: null, receipts: [] })
  })

  test('a named supplier is used; an unknown one, sizes that do not add up, bad dates or costs are refused with nothing written', async () => {
    const t = setup()
    await t.call('POST', '/suppliers', { name: 'SanMar' })
    const res = await t.call<UploadResponse>('POST', `/orders/${N}/purchases`, { supplierId: 2, description: 'Polos', quantity: 3, sizes: { M: 2, L: 1 }, expectedVersion: t.v() })
    expect(t.one('SELECT supplier_id, sizes FROM order_purchases WHERE id = ?', res.body.id)).toEqual({ supplier_id: 2, sizes: '{"M":2,"L":1}' })
    const before = t.footprint()
    const v = t.v()
    expect((await t.call('POST', `/orders/${N}/purchases`, { supplierId: 99, description: 'x', quantity: 1, expectedVersion: v })).status).toBe(404)
    for (const bad of [{ sizes: { M: 2 } }, { quantity: 0 }, { quantity: 1.5 }, { estimatedUnitCostCents: -1 }, { estimatedUnitCostCents: 1.5 }, { expectedOn: '2026-02-30' }, { description: ' ' }]) {
      expect((await t.call('POST', `/orders/${N}/purchases`, { description: 'x', quantity: 3, ...bad, expectedVersion: v })).status, JSON.stringify(bad)).toBe(400)
    }
    expect(t.footprint()).toEqual(before)
  })

  test('allowed before authorization (a UI hint, not a block); refused on a cancelled order', async () => {
    const t = setup()
    expect((await t.call('POST', '/orders/2026-0022/purchases', { description: 'Plaque blank', quantity: 1, expectedVersion: t.v('2026-0022') })).status).toBe(201)
    expect(t.order('2026-0022').production_status).toBe('awaiting_quote')
    const before = t.footprint()
    const res = await t.call('POST', '/orders/2026-0024/purchases', { description: 'x', quantity: 1, expectedVersion: t.v('2026-0024') })
    expect([res.status, res.body.code]).toEqual([409, 'order_not_active'])
    expect(t.footprint()).toEqual(before)
  })
})

describe('materials readiness follows purchases and receipts (via the re-derive)', () => {
  test('partial then full receipts; a not_ordered purchase blocks until ordered and received', async () => {
    const t = setup()
    const list = await t.purchases()
    expect(list.map((p) => [p.id, p.status, p.receivedQuantity])).toEqual([[1, 'cancelled', 0], [2, 'partially_received', 30], [3, 'not_ordered', 0]])
    expect(list[1]).toMatchObject({ estimatedTotalCents: 14000, actualTotalCents: 14600, receipts: [{ quantity: 30, sizes: { S: 6, M: 14, L: 10 }, recordedBy: 'Owner One' }] })
    expect(await t.materials()).toMatchObject({ state: 'pending', reason: 'awaiting_delivery' })

    // Purchase 2 complete; purchase 3 (not ordered) still blocks.
    const r1 = await t.call<UploadResponse>('POST', `/orders/${N}/purchases/2/receipts`, { quantity: 10, sizes: { L: 4, XL: 6 }, receivedOn: '2026-10-30', expectedVersion: t.v() })
    expect(r1.status).toBe(201)
    expect(t.one('SELECT purchase_id, quantity, received_on, recorded_by FROM purchase_receipts WHERE id = ?', r1.body.id)).toEqual({ purchase_id: 2, quantity: 10, received_on: '2026-10-30', recorded_by: 1 })
    expect((await t.purchases())[1]).toMatchObject({ status: 'received', receivedQuantity: 40, overReceived: false })
    expect(r1.body.productionStatus).toBe('awaiting_materials')
    expect(t.lastActions(N, 1)).toEqual(['purchase_received'])

    // Staff confirm purchase 3 was bought (today, shop time, by default): still awaiting delivery.
    const ordered = await t.call('POST', `/orders/${N}/purchases/3/ordered`, { expectedVersion: t.v() })
    expect([ordered.status, ordered.body.productionStatus]).toEqual([200, 'awaiting_materials'])
    expect(t.one('SELECT status, ordered_on FROM order_purchases WHERE id = 3')).toEqual({ status: 'ordered', ordered_on: businessToday(new Date()) })
    expect(t.lastActions(N, 1)).toEqual(['purchase_ordered'])

    // A partial delivery doesn't meet it; the rest does, and the re-derive moves the order on to the next item.
    expect((await t.call('POST', `/orders/${N}/purchases/3/receipts`, { quantity: 6, expectedVersion: t.v() })).body.productionStatus).toBe('awaiting_materials')
    const done = await t.call('POST', `/orders/${N}/purchases/3/receipts`, { quantity: 4, expectedVersion: t.v() })
    expect(done.body.productionStatus).toBe('awaiting_preparation')
    expect(t.order(N).production_status).toBe('awaiting_preparation')
    const rows = t.activity(t.order(N).id).slice(-2)
    expect(rows.map((r) => r.action)).toEqual(['purchase_received', 'production_status_changed'])
    expect(JSON.parse(rows[1]!.after!)).toEqual({ production_status: 'awaiting_preparation', reason: 'purchase_received' })
    expect(await t.materials()).toMatchObject({ state: 'complete' })
  })

  test('over-receiving is allowed and reported', async () => {
    const t = setup()
    expect((await t.call('POST', `/orders/${N}/purchases/2/receipts`, { quantity: 15, expectedVersion: t.v() })).status).toBe(201)
    expect((await t.purchases())[1]).toMatchObject({ status: 'received', receivedQuantity: 45, overReceived: true })
  })

  test('a cancelled purchase is excluded: cancelling the unordered one moves the order on; cancelled-only is "not ordered"', async () => {
    const t = setup()
    await t.call('POST', `/orders/${N}/purchases/2/receipts`, { quantity: 10, expectedVersion: t.v() })
    const res = await t.call('POST', `/orders/${N}/purchases/3/cancel`, { reason: 'Customer supplies the blanks', expectedVersion: t.v() })
    expect([res.status, res.body.productionStatus]).toEqual([200, 'awaiting_preparation'])
    const rows = t.activity(t.order(N).id).slice(-2)
    expect(rows.map((r) => r.action)).toEqual(['purchase_cancelled', 'production_status_changed'])
    expect(JSON.parse(rows[0]!.after!)).toEqual({ purchase_id: 3, purchase_status: 'cancelled', reason: 'Customer supplies the blanks' })
    // Cancel the received one too (receipts stay, but a cancelled purchase never counts): nothing live is left.
    const back = await t.call('POST', `/orders/${N}/purchases/2/cancel`, { reason: 'Returned', expectedVersion: t.v() })
    expect(back.body.productionStatus).toBe('awaiting_materials')
    expect(await t.materials()).toMatchObject({ state: 'pending', reason: 'not_ordered' })
    expect((await t.purchases())[1]).toMatchObject({ status: 'cancelled', receivedQuantity: 40 })
    expect((await t.call('POST', `/orders/${N}/purchases/2/cancel`, { expectedVersion: t.v() })).status).toBe(400) // reason required
  })
})

describe('receipts only on ordered purchases', () => {
  test('refused at the route for not_ordered and cancelled purchases, with nothing written', async () => {
    const t = setup()
    const before = t.footprint()
    const v = t.v()
    for (const id of [3, 1]) {
      const res = await t.call('POST', `/orders/${N}/purchases/${id}/receipts`, { quantity: 1, expectedVersion: v })
      expect([res.status, res.body.code], String(id)).toEqual([409, 'purchase_not_ordered'])
    }
    expect(t.footprint()).toEqual(before)
  })

  test('the write re-asserts it in SQL, and the trigger refuses a direct INSERT', async () => {
    const t = setup()
    const o = t.order(N)
    // The guarded INSERT … SELECT finds no ordered purchase: no receipt, no version bump, no activity.
    const before = t.footprint()
    expect(await recordReceipt(t.db, { orderId: o.id, version: o.version, actorId: 1, purchaseId: 3, quantity: 1, sizes: null, receivedOn: '2026-10-30', notes: null })).toBeNull()
    expect([t.footprint(), t.v()]).toEqual([before, o.version])
    for (const id of [3, 1]) {
      expect(() => t.sqlite.prepare("INSERT INTO purchase_receipts (purchase_id, quantity, received_on) VALUES (?, 1, '2026-10-30')").run(id)).toThrow(/purchase_not_ordered/)
    }
    t.sqlite.prepare("INSERT INTO purchase_receipts (purchase_id, quantity, received_on) VALUES (2, 1, '2026-10-30')").run()
    // Write-once.
    expect(() => t.sqlite.exec('UPDATE purchase_receipts SET quantity = 2')).toThrow(/write-once/)
    expect(() => t.sqlite.exec('DELETE FROM purchase_receipts')).toThrow(/write-once/)
    expect(() => t.sqlite.exec("REPLACE INTO purchase_receipts (id, purchase_id, quantity, received_on) VALUES (1, 2, 99, '2026-10-30')")).toThrow(/write-once/)
  })
})

describe('edits and status moves', () => {
  test('not_ordered: every field edits; a left-out field keeps its value, null clears it; no change writes nothing', async () => {
    const t = setup()
    await t.call('POST', '/suppliers', { name: 'SanMar' })
    const res = await t.call('PATCH', `/orders/${N}/purchases/3`, { supplierId: 2, description: 'Acrylic blanks 8x10', quantity: 12, estimatedUnitCostCents: 550, expectedOn: null, expectedVersion: t.v() })
    expect(res.status).toBe(200)
    expect(t.one('SELECT supplier_id, description, quantity, estimated_unit_cost_cents, expected_on, status FROM order_purchases WHERE id = 3'))
      .toEqual({ supplier_id: 2, description: 'Acrylic blanks 8x10', quantity: 12, estimated_unit_cost_cents: 550, expected_on: null, status: 'not_ordered' })
    const row = t.activity(t.order(N).id).at(-1)!
    expect(row.action).toBe('purchase_updated')
    expect(JSON.parse(row.after!)).toMatchObject({ purchase_id: 3, fields: ['supplier_id', 'description', 'quantity', 'estimated_unit_cost_cents', 'expected_on'] })
    const before = t.footprint()
    const v = t.v()
    expect((await t.call('PATCH', `/orders/${N}/purchases/3`, { quantity: 12, description: 'Acrylic blanks 8x10', expectedVersion: v })).status).toBe(200)
    expect([t.footprint(), t.v()]).toEqual([before, v])
    // Sizes are checked against the resulting quantity.
    expect((await t.call('PATCH', `/orders/${N}/purchases/3`, { sizes: { M: 5 }, expectedVersion: v })).status).toBe(400)
    expect((await t.call('PATCH', `/orders/${N}/purchases/3`, { description: null, expectedVersion: v })).status).toBe(400)
    expect(t.footprint()).toEqual(before)
  })

  test('ordered: only actual cost, expected date and notes; cancelled: nothing', async () => {
    const t = setup()
    const ok = await t.call('PATCH', `/orders/${N}/purchases/2`, { actualUnitCostCents: 370, expectedOn: '2026-11-03', notes: 'Invoice 4411', expectedVersion: t.v() })
    expect(ok.status).toBe(200)
    expect(t.one('SELECT actual_unit_cost_cents, expected_on, notes FROM order_purchases WHERE id = 2')).toEqual({ actual_unit_cost_cents: 370, expected_on: '2026-11-03', notes: 'Invoice 4411' })
    // The notes' text never goes into the activity log.
    expect(t.activity(t.order(N).id).at(-1)!.after).not.toContain('Invoice 4411')
    const before = t.footprint()
    const v = t.v()
    for (const [id, body] of [[2, { description: 'x' }], [2, { quantity: 41 }], [2, { estimatedUnitCostCents: 1 }], [2, { supplierId: 1, quantity: 39 }], [1, { notes: 'x' }], [1, { actualUnitCostCents: 1 }]] as const) {
      const res = await t.call('PATCH', `/orders/${N}/purchases/${id}`, { ...body, expectedVersion: v })
      expect([res.status, res.body.code], JSON.stringify([id, body])).toEqual([409, 'purchase_locked'])
    }
    expect(t.footprint()).toEqual(before)
  })

  test('only not_ordered -> ordered / cancelled and ordered -> cancelled, at the route and in the database', async () => {
    const t = setup()
    const before = t.footprint()
    const v = t.v()
    for (const [id, action] of [[2, 'ordered'], [1, 'ordered'], [1, 'cancel']] as const) {
      const res = await t.call('POST', `/orders/${N}/purchases/${id}/${action}`, { reason: 'x', expectedVersion: v })
      expect([res.status, res.body.code], `${id} ${action}`).toEqual([409, 'purchase_transition_not_allowed'])
    }
    expect(t.footprint()).toEqual(before)
    expect(() => t.sqlite.exec("UPDATE order_purchases SET status = 'ordered' WHERE id = 1")).toThrow(/purchase_transition_not_allowed/)
    expect(() => t.sqlite.exec("UPDATE order_purchases SET status = 'not_ordered' WHERE id = 2")).toThrow(/purchase_transition_not_allowed/)
    expect(() => t.sqlite.exec('UPDATE order_purchases SET order_id = 10 WHERE id = 2')).toThrow(/purchase_order_fixed/)
    expect(() => t.sqlite.exec("UPDATE order_purchases SET status = 'ordered', ordered_on = NULL WHERE id = 3")).toThrow(/CHECK constraint failed/)
    expect((await t.call('PATCH', `/orders/${N}/purchases/99`, { notes: 'x', expectedVersion: v })).status).toBe(404)
    expect((await t.call('PATCH', '/orders/2026-0010/purchases/2', { notes: 'x', expectedVersion: t.v('2026-0010') })).status).toBe(404) // another order's
  })
})

test('a stale expectedVersion is 409 on every write, with no row and no activity', async () => {
  const t = setup()
  const stale = t.v() + 1
  const before = t.footprint()
  for (const [method, path, body] of [
    ['POST', `/orders/${N}/purchases`, { description: 'x', quantity: 1 }],
    ['PATCH', `/orders/${N}/purchases/3`, { notes: 'x' }],
    ['POST', `/orders/${N}/purchases/3/ordered`, {}],
    ['POST', `/orders/${N}/purchases/3/cancel`, { reason: 'x' }],
    ['POST', `/orders/${N}/purchases/2/receipts`, { quantity: 1 }],
    ['PATCH', `/orders/${N}/prep`, { prepStatus: 'ready' }],
  ] as const) {
    const res = await t.call(method, path, { ...body, expectedVersion: stale })
    expect([res.status, res.body.code], path).toEqual([409, 'conflict_retry'])
  }
  expect(t.footprint()).toEqual(before)
  expect(t.order(N).production_status).toBe('awaiting_materials')
})

describe('"No purchasing needed" and prep', () => {
  test('needs confirmNoPurchasing, and does not bypass prep or artwork', async () => {
    const t = setup()
    const refused = await t.call('PATCH', `/orders/${N}`, { materialsRequired: false, expectedVersion: t.v() })
    expect([refused.status, refused.body.code]).toEqual([400, 'confirmation_required'])
    // Materials no longer required, but prep is not_started: awaiting_preparation, not ready.
    const res = await t.call('PATCH', `/orders/${N}`, { materialsRequired: false, confirmNoPurchasing: true, expectedVersion: t.v() })
    expect(res.body.productionStatus).toBe('awaiting_preparation')
    expect(await t.materials()).toMatchObject({ state: 'not_required' })
    // Order 8 is waiting on artwork: confirming no purchasing leaves it there.
    expect((await t.call('PATCH', '/orders/2026-0008', { materialsRequired: false, confirmNoPurchasing: true, expectedVersion: t.v('2026-0008') })).body.productionStatus).toBe('awaiting_artwork')
  })

  test('prep changes re-derive the production status, with an activity row; same value writes nothing', async () => {
    const t = setup()
    const n = '2026-0018' // everything met except prep (in_progress)
    const res = await t.call('PATCH', `/orders/${n}/prep`, { prepStatus: 'ready', expectedVersion: t.v(n) })
    expect([res.status, res.body.productionStatus]).toEqual([200, 'ready'])
    const rows = t.activity(t.order(n).id).slice(-2)
    expect(rows.map((r) => [r.action, JSON.parse(r.after!)])).toEqual([
      ['prep_status_changed', { prep_status: 'ready' }], ['production_status_changed', { production_status: 'ready', reason: 'prep_status_changed' }]])
    expect((await t.call('PATCH', `/orders/${n}/prep`, { prepStatus: 'in_progress', expectedVersion: t.v(n) })).body.productionStatus).toBe('awaiting_preparation')
    expect((await t.call('PATCH', `/orders/${n}/prep`, { prepStatus: 'not_required', expectedVersion: t.v(n) })).body.productionStatus).toBe('ready')
    const before = t.footprint()
    const v = t.v(n)
    expect((await t.call('PATCH', `/orders/${n}/prep`, { prepStatus: 'not_required', expectedVersion: v })).status).toBe(200)
    expect((await t.call('PATCH', `/orders/${n}/prep`, { prepStatus: 'done', expectedVersion: v })).status).toBe(400)
    expect([t.footprint(), t.v(n)]).toEqual([before, v])
    // On a cancelled order: refused.
    expect((await t.call('PATCH', '/orders/2026-0024/prep', { prepStatus: 'ready', expectedVersion: t.v('2026-0024') })).body.code).toBe('order_not_active')
  })
})

test('every purchasing write logs a code from ACTIVITY_ACTIONS, and all of them are reachable', async () => {
  const t = setup()
  await t.call('POST', '/suppliers', { name: 'SanMar' })
  const { body } = await t.call<UploadResponse>('POST', `/orders/${N}/purchases`, { description: 'x', quantity: 2, expectedVersion: t.v() })
  await t.call('PATCH', `/orders/${N}/purchases/${body.id}`, { quantity: 3, expectedVersion: t.v() })
  await t.call('POST', `/orders/${N}/purchases/${body.id}/ordered`, { expectedVersion: t.v() })
  await t.call('POST', `/orders/${N}/purchases/${body.id}/receipts`, { quantity: 1, expectedVersion: t.v() })
  await t.call('POST', `/orders/${N}/purchases/${body.id}/cancel`, { reason: 'x', expectedVersion: t.v() })
  await t.call('PATCH', `/orders/${N}/prep`, { prepStatus: 'in_progress', expectedVersion: t.v() })
  const actions = (t.sqlite.prepare("SELECT DISTINCT action FROM activity_log WHERE action LIKE 'purchase%' OR action LIKE 'supplier%' OR action LIKE 'prep%'").all() as { action: string }[]).map((r) => r.action)
  expect(actions.sort()).toEqual(['prep_status_changed', 'purchase_cancelled', 'purchase_created', 'purchase_ordered', 'purchase_received', 'purchase_updated', 'supplier_created'])
  for (const a of actions) expect(ACTIVITY_ACTIONS as readonly string[]).toContain(a)
})
