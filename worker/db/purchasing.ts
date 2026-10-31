// SQL for suppliers, order purchases, receipts and production prep (M3). Every order-scoped write is one orderWrite
// batch: its data statement carries GUARD (the client's order version) and re-asserts the purchase's status, the
// order UPDATE applies only if that statement changed a row (changes() > 0), then the activity row and the re-derive,
// so production_status follows readiness. Values are bound; the interpolated fragments are constants from this file.
import type { PrepStatus, PurchaseStoredStatus } from '../../shared/enums'
import type { Supplier } from '../../shared/api'
import type { PurchaseField } from '../domain/purchasing'
import { GUARD, orderWriteResults } from './orders'

type Guarded = { orderId: number; version: number; actorId: number }
type Value = string | number | null
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
const newId = (r: { results?: unknown[] } | undefined) => (r?.results?.[0] as { id: number } | undefined)?.id ?? null
const sizesJson = (s: Record<string, number> | null) => (s ? JSON.stringify(s) : null)

// ---- suppliers ----

type SupplierRow = { id: number; name: string; is_default: 0 | 1 }
const toSupplier = (r: SupplierRow): Supplier => ({ id: r.id, name: r.name, isDefault: r.is_default === 1 })

export async function listSuppliers(db: D1Database) {
  const { results } = await db.prepare('SELECT id, name, is_default FROM suppliers ORDER BY is_default DESC, name COLLATE NOCASE').all<SupplierRow>()
  return results.map(toSupplier)
}
/** supplierId, or the default supplier when undefined; null when there is no such supplier. */
export async function getSupplier(db: D1Database, supplierId: number | undefined) {
  const r = await (supplierId === undefined
    ? db.prepare('SELECT id, name, is_default FROM suppliers WHERE is_default = 1')
    : db.prepare('SELECT id, name, is_default FROM suppliers WHERE id = ?').bind(supplierId)).first<SupplierRow>()
  return r && toSupplier(r)
}
/** Throws the UNIQUE error on a duplicate name (any case); the route maps it to 409 supplier_exists. */
export async function createSupplier(db: D1Database, p: { name: string; actorId: number }) {
  const [insert] = await db.batch([
    db.prepare('INSERT INTO suppliers (name) VALUES (?) RETURNING id, name, is_default').bind(p.name),
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
      SELECT 'user', ?, 'supplier', id, 'supplier_created', json_object('name', name) FROM suppliers WHERE name = ?`).bind(p.actorId, p.name),
  ])
  return toSupplier(insert!.results![0] as SupplierRow)
}

// ---- purchases ----

export type PurchaseRow = {
  id: number; supplier_id: number; supplier_name: string; description: string; quantity: number; sizes: string | null
  estimated_unit_cost_cents: number | null; actual_unit_cost_cents: number | null; status: PurchaseStoredStatus
  ordered_on: string | null; expected_on: string | null; notes: string | null; created_by_name: string | null; created_at: string; updated_at: string
}
export type ReceiptRow = {
  id: number; purchase_id: number; quantity: number; sizes: string | null; received_on: string; notes: string | null; recorded_by_name: string | null; created_at: string
}
const PURCHASE_SELECT = `SELECT p.id, p.supplier_id, s.name AS supplier_name, p.description, p.quantity, p.sizes, p.estimated_unit_cost_cents,
  p.actual_unit_cost_cents, p.status, p.ordered_on, p.expected_on, p.notes, u.name AS created_by_name, p.created_at, p.updated_at
  FROM order_purchases p JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN users u ON u.id = p.created_by`

/** The order's purchases (oldest first) and every receipt (oldest first). */
export async function listPurchases(db: D1Database, orderId: number) {
  const [purchases, receipts] = await Promise.all([
    db.prepare(`${PURCHASE_SELECT} WHERE p.order_id = ? ORDER BY p.id`).bind(orderId).all<PurchaseRow>(),
    db.prepare(`SELECT r.id, r.purchase_id, r.quantity, r.sizes, r.received_on, r.notes, u.name AS recorded_by_name, r.created_at
        FROM purchase_receipts r JOIN order_purchases p ON p.id = r.purchase_id LEFT JOIN users u ON u.id = r.recorded_by
        WHERE p.order_id = ? ORDER BY r.id`).bind(orderId).all<ReceiptRow>(),
  ])
  return { purchases: purchases.results, receipts: receipts.results }
}
export const getPurchase = (db: D1Database, orderId: number, purchaseId: number) =>
  db.prepare(`${PURCHASE_SELECT} WHERE p.id = ? AND p.order_id = ?`).bind(purchaseId, orderId).first<PurchaseRow>()

export type PurchaseValues = {
  supplierId: number; description: string; quantity: number; sizes: Record<string, number> | null
  estimatedUnitCostCents: number | null; actualUnitCostCents: number | null; expectedOn: string | null; notes: string | null
}
// Field -> column. The only interpolated SQL fragments in updatePurchase come from here.
const COLUMNS: Record<PurchaseField, string> = {
  supplierId: 'supplier_id', description: 'description', quantity: 'quantity', sizes: 'sizes',
  estimatedUnitCostCents: 'estimated_unit_cost_cents', actualUnitCostCents: 'actual_unit_cost_cents', expectedOn: 'expected_on', notes: 'notes',
}
const bindValue = (f: PurchaseField, v: PurchaseValues[PurchaseField]): Value => (f === 'sizes' ? sizesJson(v as PurchaseValues['sizes']) : (v as Value))
// Logged values: never the internal notes' text (only that they changed).
const logged = (fields: PurchaseField[], v: Partial<PurchaseValues>) =>
  Object.fromEntries(fields.filter((f) => f !== 'notes').map((f) => [COLUMNS[f], bindValue(f, v[f]!)]))

/** A new purchase in not_ordered. Returns null on a stale version (nothing written). */
export async function createPurchase(db: D1Database, p: Guarded & { values: Omit<PurchaseValues, 'actualUnitCostCents'>; supplierName: string }) {
  const v = p.values
  const { state, data } = await orderWriteResults(db, {
    ...p, action: 'purchase_created',
    data: [db.prepare(`INSERT INTO order_purchases (order_id, supplier_id, description, quantity, sizes, estimated_unit_cost_cents, expected_on, notes, created_by)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${GUARD} RETURNING id`)
      .bind(p.orderId, v.supplierId, v.description, v.quantity, sizesJson(v.sizes), v.estimatedUnitCostCents, v.expectedOn, v.notes, p.actorId, p.orderId, p.version)],
    after: { purchase_status: 'not_ordered', supplier_name: p.supplierName, description: v.description, quantity: v.quantity },
  })
  const id = newId(data[0])
  return state && id !== null ? { state, id } : null
}

/** Changes `fields` while the purchase is still in `status` (the route checked the lock for that status). */
export async function updatePurchase(db: D1Database, p: Guarded & {
  purchaseId: number; status: PurchaseStoredStatus; fields: PurchaseField[]; before: PurchaseValues; after: PurchaseValues
}) {
  const { state } = await orderWriteResults(db, {
    ...p, action: 'purchase_updated',
    data: [db.prepare(`UPDATE order_purchases SET ${p.fields.map((f) => `${COLUMNS[f]} = ?, `).join('')}updated_at = ${NOW}
        WHERE id = ? AND order_id = ? AND status = ? AND ${GUARD}`)
      .bind(...p.fields.map((f) => bindValue(f, p.after[f])), p.purchaseId, p.orderId, p.status, p.orderId, p.version)],
    where: ['changes() > 0'],
    before: { purchase_id: p.purchaseId, ...logged(p.fields, p.before) },
    after: { purchase_id: p.purchaseId, ...logged(p.fields, p.after), fields: p.fields.map((f) => COLUMNS[f]) },
  })
  return state
}

/** Staff confirm the purchase was made: not_ordered -> ordered on `orderedOn`. */
export async function markPurchaseOrdered(db: D1Database, p: Guarded & { purchaseId: number; orderedOn: string }) {
  const { state } = await orderWriteResults(db, {
    ...p, action: 'purchase_ordered',
    data: [db.prepare(`UPDATE order_purchases SET status = 'ordered', ordered_on = ?, updated_at = ${NOW}
        WHERE id = ? AND order_id = ? AND status = 'not_ordered' AND ${GUARD}`).bind(p.orderedOn, p.purchaseId, p.orderId, p.orderId, p.version)],
    where: ['changes() > 0'],
    before: { purchase_id: p.purchaseId, purchase_status: 'not_ordered' },
    after: { purchase_id: p.purchaseId, purchase_status: 'ordered', ordered_on: p.orderedOn },
  })
  return state
}

/** not_ordered / ordered -> cancelled. Receipts already recorded stay. The reason goes in the activity row. */
export async function cancelPurchase(db: D1Database, p: Guarded & { purchaseId: number; from: PurchaseStoredStatus; reason: string }) {
  const { state } = await orderWriteResults(db, {
    ...p, action: 'purchase_cancelled',
    data: [db.prepare(`UPDATE order_purchases SET status = 'cancelled', updated_at = ${NOW}
        WHERE id = ? AND order_id = ? AND status = ? AND ${GUARD}`).bind(p.purchaseId, p.orderId, p.from, p.orderId, p.version)],
    where: ['changes() > 0'],
    before: { purchase_id: p.purchaseId, purchase_status: p.from },
    after: { purchase_id: p.purchaseId, purchase_status: 'cancelled', reason: p.reason },
  })
  return state
}

/** One delivery, only while the purchase is ordered (re-asserted here and by the purchase_receipts_need_ordered trigger). */
export async function recordReceipt(db: D1Database, p: Guarded & {
  purchaseId: number; quantity: number; sizes: Record<string, number> | null; receivedOn: string; notes: string | null
}) {
  const { state, data } = await orderWriteResults(db, {
    ...p, action: 'purchase_received',
    data: [db.prepare(`INSERT INTO purchase_receipts (purchase_id, quantity, sizes, received_on, notes, recorded_by)
        SELECT id, ?, ?, ?, ?, ? FROM order_purchases WHERE id = ? AND order_id = ? AND status = 'ordered' AND ${GUARD} RETURNING id`)
      .bind(p.quantity, sizesJson(p.sizes), p.receivedOn, p.notes, p.actorId, p.purchaseId, p.orderId, p.orderId, p.version)],
    where: ['changes() > 0'],
    after: { purchase_id: p.purchaseId, quantity: p.quantity, received_on: p.receivedOn },
  })
  const id = newId(data[0])
  return state && id !== null ? { state, id } : null
}

// ---- production prep ----

export async function setPrepStatus(db: D1Database, p: Guarded & { from: PrepStatus; to: PrepStatus }) {
  const { state } = await orderWriteResults(db, {
    ...p, action: 'prep_status_changed', set: [['prep_status = ?', p.to]],
    before: { prep_status: p.from }, after: { prep_status: p.to },
  })
  return state
}
