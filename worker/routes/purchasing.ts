// Suppliers, order purchases, receipts and production prep (M3). HTTP, auth and validation only: the rules are in
// worker/domain/purchasing.ts, the SQL (one batch per write, with its activity row and the re-derive) in worker/db/purchasing.ts.
// Purchasing is allowed before authorization: the brief's "normally begins after authorization" is a UI hint (DECISIONS 2026-10-31).
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../auth'
import type { ApiErrorCode, OrderWriteResponse, PurchaseRecord, PurchasesResponse, SupplierResponse, SuppliersResponse, UploadResponse } from '../../shared/api'
import { PREP_STATUSES } from '../../shared/enums'
import { businessToday } from '../../shared/businessDate'
import { checkPurchaseEdit, checkPurchaseTransition, checkReceipt, PURCHASE_FIELDS, purchaseStatus, purchaseTotal, type PurchaseField } from '../domain/purchasing'
import { sizesTotal } from '../domain/quotes'
import * as db from '../db/purchasing'
import { getOrderByNumber, orderState } from '../db/orders'
import { businessDate } from './orderWrites'
import { bad, number } from './orders'

type C = Context<AppEnv>
type Order = NonNullable<Awaited<ReturnType<typeof getOrderByNumber>>>
type State = Awaited<ReturnType<typeof orderState>>

const pathId = z.string().regex(/^[1-9]\d{0,14}$/, 'invalid id').transform(Number)
const id = z.number().int().positive()
const expectedVersion = z.number().int().min(0)
const text = (max: number) => z.string().trim().min(1).max(max)
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null)
const quantity = z.number().int().min(1).max(1_000_000)
const unitCents = z.number().int().min(0).max(100_000_000).nullish().transform((v) => v ?? null)
const sizes = z.record(z.string().trim().min(1).max(20), z.number().int().min(0)).nullish().transform((v) => (v && Object.keys(v).length ? v : null))
const date = businessDate.nullish().transform((v) => v ?? null)
// Same rule as an order item's size breakdown: when given, it adds up to the quantity.
const sizesMatch = (v: { sizes?: Record<string, number> | null; quantity?: number }) => {
  if (!v.sizes || v.quantity === undefined) return true
  const t = sizesTotal(v.sizes)
  return t.ok && t.quantity === v.quantity
}
const SIZES_MSG = { message: 'sizes must add up to quantity', path: ['sizes'] }

const createBody = z.object({
  supplierId: id.optional(), description: text(200), quantity, sizes, estimatedUnitCostCents: unitCents, expectedOn: date, notes: optText(2000), expectedVersion,
}).refine(sizesMatch, SIZES_MSG)
const patchBody = z.object({
  supplierId: id.optional(), description: text(200).optional(), quantity: quantity.optional(), sizes, estimatedUnitCostCents: unitCents,
  actualUnitCostCents: unitCents, expectedOn: date, notes: optText(2000), expectedVersion,
})
const orderedBody = z.object({ orderedOn: businessDate.optional(), expectedVersion })
const cancelBody = z.object({ reason: text(500), expectedVersion })
const receiptBody = z.object({ quantity, sizes, receivedOn: businessDate.optional(), notes: optText(2000), expectedVersion }).refine(sizesMatch, SIZES_MSG)
const prepBody = z.object({ prepStatus: z.enum(PREP_STATUSES), expectedVersion })

// Trigger messages from migration 0004 that restate a rule the route checks first (a race got past the read).
const DB_ERROR_CODES = ['purchase_not_ordered', 'purchase_transition_not_allowed'] as const

const refuse = (c: C, code: ApiErrorCode, error: string, status: 400 | 404 | 409 = 409) => c.json({ error, code }, status)
const conflict = (c: C) => refuse(c, 'conflict_retry', 'Order changed, reload and retry')
const notFound = (c: C, what: string) => refuse(c, 'not_found', `${what} not found`, 404)
const notActive = (c: C) => refuse(c, 'order_not_active', 'Order is cancelled or closed')
const written = (c: C, state: State) => (state ? c.json<OrderWriteResponse>(state) : conflict(c))
const created = (c: C, r: { state: NonNullable<State>; id: number } | null) => (r ? c.json<UploadResponse>({ ...r.state, id: r.id }, 201) : conflict(c))
const today = () => businessToday(new Date())
const parseSizes = (s: string | null) => (s === null ? null : (JSON.parse(s) as Record<string, number>))

/**
 * Parses :number and the body, loads the order (404), refuses a stale expectedVersion and a non-active order before
 * anything runs. The batch re-checks the version the client sent either way. `raw` is the body as sent, so a PATCH
 * can tell a left-out field from a null one.
 */
function withOrder<S extends z.ZodType>(schema: S, fn: (c: C, o: Order, body: z.infer<S>, raw: Record<string, unknown>) => Promise<Response>) {
  return async (c: C) => {
    const n = number.safeParse(c.req.param('number'))
    if (!n.success) return bad(c, n.error)
    const raw: unknown = await c.req.json().catch(() => null)
    const body = schema.safeParse(raw)
    if (!body.success) return bad(c, body.error)
    const o = await getOrderByNumber(c.env.DB, n.data)
    if (!o) return notFound(c, 'Order')
    if ((body.data as { expectedVersion: number }).expectedVersion !== o.version) return conflict(c)
    if (o.state !== 'active') return notActive(c)
    return fn(c, o, body.data, raw as Record<string, unknown>)
  }
}
/** withOrder plus :purchaseId, which must be this order's purchase (404). */
function withPurchase<S extends z.ZodType>(schema: S, fn: (c: C, o: Order, p: db.PurchaseRow, body: z.infer<S>, raw: Record<string, unknown>) => Promise<Response>) {
  return withOrder(schema, async (c, o, body, raw) => {
    const pid = pathId.safeParse(c.req.param('purchaseId'))
    if (!pid.success) return bad(c, pid.error)
    const p = await db.getPurchase(c.env.DB, o.id, pid.data)
    if (!p) return notFound(c, 'Purchase')
    return fn(c, o, p, body, raw)
  })
}

const values = (p: db.PurchaseRow): db.PurchaseValues => ({
  supplierId: p.supplier_id, description: p.description, quantity: p.quantity, sizes: parseSizes(p.sizes),
  estimatedUnitCostCents: p.estimated_unit_cost_cents, actualUnitCostCents: p.actual_unit_cost_cents, expectedOn: p.expected_on, notes: p.notes,
})

function toRecord(p: db.PurchaseRow, receipts: db.ReceiptRow[]): PurchaseRecord {
  const derived = purchaseStatus({ storedStatus: p.status, quantity: p.quantity }, receipts)
  // The CHECKs keep every stored quantity a positive integer, so the derivation can't fail on stored rows.
  if (!derived.ok) throw new Error(`purchase ${p.id}: ${derived.error}`)
  return {
    id: p.id, supplierId: p.supplier_id, supplierName: p.supplier_name, description: p.description, quantity: p.quantity, sizes: parseSizes(p.sizes),
    estimatedUnitCostCents: p.estimated_unit_cost_cents, actualUnitCostCents: p.actual_unit_cost_cents,
    estimatedTotalCents: purchaseTotal(p.quantity, p.estimated_unit_cost_cents), actualTotalCents: purchaseTotal(p.quantity, p.actual_unit_cost_cents),
    status: derived.status, receivedQuantity: derived.receivedQuantity, overReceived: derived.overReceived,
    orderedOn: p.ordered_on, expectedOn: p.expected_on, notes: p.notes, createdBy: p.created_by_name, createdAt: p.created_at, updatedAt: p.updated_at,
    receipts: receipts.map((r) => ({
      id: r.id, quantity: r.quantity, sizes: parseSizes(r.sizes), receivedOn: r.received_on, notes: r.notes, recordedBy: r.recorded_by_name, createdAt: r.created_at,
    })),
  }
}

export function purchasingRoutes() {
  return new Hono<AppEnv>()
    .onError((e, c) => {
      const message = e instanceof Error ? e.message : String(e)
      const code = DB_ERROR_CODES.find((k) => message.includes(k))
      if (code) return refuse(c, code, message)
      if (/UNIQUE constraint failed: suppliers\.name/.test(message)) return refuse(c, 'supplier_exists', 'A supplier with that name already exists')
      console.error(e)
      return c.json({ error: 'Internal error' }, 500)
    })

    .get('/suppliers', async (c) => c.json<SuppliersResponse>({ suppliers: await db.listSuppliers(c.env.DB) }))

    .post('/suppliers', async (c) => {
      const b = z.object({ name: text(100) }).safeParse(await c.req.json().catch(() => null))
      if (!b.success) return bad(c, b.error)
      return c.json<SupplierResponse>({ supplier: await db.createSupplier(c.env.DB, { name: b.data.name, actorId: c.get('user').id }) }, 201)
    })

    .get('/orders/:number/purchases', async (c) => {
      const n = number.safeParse(c.req.param('number'))
      if (!n.success) return bad(c, n.error)
      const o = await getOrderByNumber(c.env.DB, n.data)
      if (!o) return notFound(c, 'Order')
      const { purchases, receipts } = await db.listPurchases(c.env.DB, o.id)
      return c.json<PurchasesResponse>({ purchases: purchases.map((p) => toRecord(p, receipts.filter((r) => r.purchase_id === p.id))) })
    })

    .post('/orders/:number/purchases', withOrder(createBody, async (c, o, b) => {
      const supplier = await db.getSupplier(c.env.DB, b.supplierId)
      if (!supplier) return notFound(c, 'Supplier')
      return created(c, await db.createPurchase(c.env.DB, {
        orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, supplierName: supplier.name,
        values: { supplierId: supplier.id, description: b.description, quantity: b.quantity, sizes: b.sizes, estimatedUnitCostCents: b.estimatedUnitCostCents, expectedOn: b.expectedOn, notes: b.notes },
      }))
    }))

    .patch('/orders/:number/purchases/:purchaseId', withPurchase(patchBody, async (c, o, p, b, raw) => {
      const before = values(p)
      const after = { ...before }
      for (const f of PURCHASE_FIELDS) if (f in raw) (after as Record<PurchaseField, unknown>)[f] = b[f]
      const fields = PURCHASE_FIELDS.filter((f) => JSON.stringify(after[f]) !== JSON.stringify(before[f]))
      if (!fields.length) return written(c, await orderState(c.env.DB, { id: o.id }))
      const lock = checkPurchaseEdit(p.status, fields)
      if (!lock.ok) return refuse(c, 'purchase_locked', `A ${p.status} purchase cannot change ${fields.join(', ')}`)
      if (!sizesMatch(after)) return refuse(c, 'invalid_request', SIZES_MSG.message, 400)
      if (fields.includes('supplierId') && !(await db.getSupplier(c.env.DB, after.supplierId))) return notFound(c, 'Supplier')
      return written(c, await db.updatePurchase(c.env.DB, { orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, purchaseId: p.id, status: p.status, fields, before, after }))
    }))

    .post('/orders/:number/purchases/:purchaseId/ordered', withPurchase(orderedBody, async (c, o, p, b) => {
      const check = checkPurchaseTransition(p.status, 'ordered')
      if (!check.ok) return refuse(c, 'purchase_transition_not_allowed', `A ${p.status} purchase cannot be marked ordered`)
      return written(c, await db.markPurchaseOrdered(c.env.DB, {
        orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, purchaseId: p.id, orderedOn: b.orderedOn ?? today(),
      }))
    }))

    .post('/orders/:number/purchases/:purchaseId/cancel', withPurchase(cancelBody, async (c, o, p, b) => {
      const check = checkPurchaseTransition(p.status, 'cancelled')
      if (!check.ok) return refuse(c, 'purchase_transition_not_allowed', `A ${p.status} purchase cannot be cancelled`)
      return written(c, await db.cancelPurchase(c.env.DB, { orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, purchaseId: p.id, from: p.status, reason: b.reason }))
    }))

    .post('/orders/:number/purchases/:purchaseId/receipts', withPurchase(receiptBody, async (c, o, p, b) => {
      const check = checkReceipt({ storedStatus: p.status, quantity: p.quantity }, { quantity: b.quantity })
      if (!check.ok) return check.error === 'purchase_not_ordered' ? refuse(c, 'purchase_not_ordered', 'Only an ordered purchase can be received') : refuse(c, 'invalid_request', check.error, 400)
      return created(c, await db.recordReceipt(c.env.DB, {
        orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, purchaseId: p.id, quantity: b.quantity, sizes: b.sizes,
        receivedOn: b.receivedOn ?? today(), notes: b.notes,
      }))
    }))

    .patch('/orders/:number/prep', withOrder(prepBody, async (c, o, b) => {
      if (b.prepStatus === o.prep_status) return written(c, await orderState(c.env.DB, { id: o.id }))
      return written(c, await db.setPrepStatus(c.env.DB, { orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, from: o.prep_status, to: b.prepStatus }))
    }))
}
