// All SQL for the order screens. Every value is bound; the only interpolated
// fragments are the constants in VIEW_WHERE and generated "?,?" placeholder lists.
import { METHODS } from '../../shared/enums'
import type { ArtworkStatus, CustomerKind, Method, OrderSource, OrderState, PoStatus, ProductionStatus } from '../../shared/enums'
import type { InquiryListRow, OrderCounts, OrderDetailResponse, OrderListRow, OrderView } from '../../shared/api'
import type { DashInquiry, DashOrder } from '../domain/dashboard'
import type { GateOrder, GatePo } from '../domain/production'

type BaseRow = {
  id: number
  number: string
  customer_name: string
  customer_kind: CustomerKind
  title: string
  artwork_status: ArtworkStatus
  po_required: 0 | 1
  production_status: ProductionStatus
  state: OrderState
  due_date: string | null
  estimated_total_cents: number | null
  latest_po_status: PoStatus | null
  latest_po_amount: number | null
  latest_estimate_status: string | null
  methods: string | null
  total_qty: number
}

// "Latest" PO = highest id; latest estimate = highest version.
const BASE = `SELECT o.id, o.number, c.name AS customer_name, c.kind AS customer_kind, o.title, o.artwork_status,
  o.po_required, o.production_status, o.state, o.due_date, o.estimated_total_cents,
  (SELECT p.status FROM purchase_orders p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS latest_po_status,
  (SELECT p.amount_cents FROM purchase_orders p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS latest_po_amount,
  (SELECT e.status FROM estimates e WHERE e.order_id = o.id ORDER BY e.version DESC LIMIT 1) AS latest_estimate_status,
  (SELECT group_concat(DISTINCT i.method) FROM order_items i WHERE i.order_id = o.id) AS methods,
  (SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i WHERE i.order_id = o.id) AS total_qty
  FROM orders o JOIN customers c ON c.id = o.customer_id`

// Predicates over the BASE columns. 'inquiries' is counted from its own table.
const VIEW_WHERE: Record<Exclude<OrderView, 'inquiries'>, string> = {
  active: `state = 'active'`,
  waiting_po: `state = 'active' AND po_required = 1 AND (latest_po_status IS NULL OR latest_po_status <> 'approved')`,
  waiting_artwork: `state = 'active' AND artwork_status <> 'approved'`,
  in_production: `production_status IN ('in_production','quality_control')`,
  ready: `production_status = 'ready_for_pickup'`,
  completed: `state = 'completed'`,
}

const likeEscape = (q: string) => q.replace(/[\\%_]/g, (ch) => `\\${ch}`)

function toListRow(r: BaseRow): OrderListRow {
  const methods = (r.methods ?? '').split(',').filter(Boolean) as Method[]
  return {
    number: r.number,
    customerName: r.customer_name,
    customerKind: r.customer_kind,
    title: r.title,
    methods: methods.sort((a, b) => METHODS.indexOf(a) - METHODS.indexOf(b)),
    totalQty: r.total_qty,
    artworkStatus: r.artwork_status,
    poRequired: r.po_required === 1,
    latestPoStatus: r.latest_po_status,
    productionStatus: r.production_status,
    state: r.state,
    dueDate: r.due_date,
    estimatedTotalCents: r.estimated_total_cents,
  }
}

export async function listOrders(db: D1Database, view: Exclude<OrderView, 'inquiries'>, q: string | undefined, limit: number) {
  const params: (string | number)[] = []
  let where = VIEW_WHERE[view]
  if (q) {
    const like = `%${likeEscape(q)}%`
    where += ` AND (b.number LIKE ? ESCAPE '\\' OR b.customer_name LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM purchase_orders p WHERE p.order_id = b.id AND p.po_number LIKE ? ESCAPE '\\'))`
    params.push(`${likeEscape(q)}%`, like, like)
  }
  const { results } = await db
    .prepare(`WITH base AS (${BASE}) SELECT * FROM base b WHERE ${where} ORDER BY b.due_date IS NULL, b.due_date, b.number LIMIT ?`)
    .bind(...params, limit)
    .all<BaseRow>()
  return results.map(toListRow)
}

export async function listInquiries(db: D1Database, q: string | undefined, limit: number): Promise<InquiryListRow[]> {
  const like = q ? `%${likeEscape(q)}%` : '%'
  const { results } = await db
    .prepare(
      `SELECT id, contact_name, contact_email, contact_phone, created_at FROM inquiries
       WHERE status = 'new' AND (contact_name LIKE ?1 ESCAPE '\\' OR contact_email LIKE ?1 ESCAPE '\\')
       ORDER BY created_at DESC, id DESC LIMIT ?2`,
    )
    .bind(like, limit)
    .all<{ id: number; contact_name: string | null; contact_email: string | null; contact_phone: string | null; created_at: string }>()
  return results.map((r) => ({ id: r.id, contactName: r.contact_name, contactEmail: r.contact_email, contactPhone: r.contact_phone, createdAt: r.created_at }))
}

export async function orderCounts(db: D1Database): Promise<OrderCounts> {
  const sums = Object.entries(VIEW_WHERE).map(([k, w]) => `COALESCE(SUM(CASE WHEN ${w} THEN 1 ELSE 0 END), 0) AS ${k}`)
  const row = await db.prepare(`WITH base AS (${BASE}) SELECT ${sums.join(', ')} FROM base`).first<Omit<OrderCounts, 'inquiries'>>()
  const inq = await db.prepare(`SELECT COUNT(*) AS n FROM inquiries WHERE status = 'new'`).first<{ n: number }>()
  return { ...(row as Omit<OrderCounts, 'inquiries'>), inquiries: inq?.n ?? 0 }
}

// ---- dashboard ----

export async function listActiveDashOrders(db: D1Database): Promise<DashOrder[]> {
  // ponytail: loads every active order and counts in JS; a small shop has hundreds. Move to SQL aggregates if it ever has thousands.
  const { results } = await db.prepare(`WITH base AS (${BASE}) SELECT * FROM base WHERE state = 'active'`).all<BaseRow>()
  return results.map((r) => ({
    id: r.id,
    number: r.number,
    customerName: r.customer_name,
    title: r.title,
    artworkStatus: r.artwork_status,
    productionStatus: r.production_status,
    dueDate: r.due_date,
    latestPoStatus: r.latest_po_status,
    latestPoAmountCents: r.latest_po_amount,
    latestEstimateStatus: r.latest_estimate_status,
  }))
}

/** When each order last entered ready_for_pickup, read from the activity log. */
export async function readyForPickupSince(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT entity_id, MAX(at) AS at FROM activity_log
       WHERE entity_type = 'order' AND json_extract(after, '$.production_status') = 'ready_for_pickup' GROUP BY entity_id`,
    )
    .all<{ entity_id: number; at: string }>()
  return new Map(results.map((r) => [r.entity_id, r.at]))
}

export async function listNewInquiriesForDashboard(db: D1Database): Promise<DashInquiry[]> {
  const { results } = await db
    .prepare(`SELECT id, contact_name FROM inquiries WHERE status = 'new' ORDER BY created_at DESC, id DESC LIMIT 10`)
    .all<{ id: number; contact_name: string | null }>()
  return results.map((r) => ({ id: r.id, contactName: r.contact_name }))
}

export async function itemsSummaries(db: D1Database, orderIds: number[]) {
  const out = new Map<number, string>()
  if (orderIds.length === 0) return out
  const { results } = await db
    .prepare(`SELECT order_id, product, quantity FROM order_items WHERE order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY id`)
    .bind(...orderIds)
    .all<{ order_id: number; product: string; quantity: number }>()
  for (const r of results) out.set(r.order_id, [out.get(r.order_id), `${r.quantity} ${r.product}`].filter(Boolean).join(', '))
  return out
}

export async function recentActivity(db: D1Database) {
  // note bodies are never selected; before/after are not selected either.
  const { results } = await db
    .prepare(
      `SELECT COALESCE(u.name, a.actor_kind) AS actor, a.action, a.entity_type, a.entity_id, o.number AS order_number, a.at
       FROM activity_log a LEFT JOIN users u ON u.id = a.actor_id
       LEFT JOIN orders o ON a.entity_type = 'order' AND o.id = a.entity_id
       ORDER BY a.id DESC LIMIT 10`,
    )
    .all<{ actor: string; action: string; entity_type: string; entity_id: number; order_number: string | null; at: string }>()
  return results.map((r) => ({ actor: r.actor, action: r.action, entityType: r.entity_type, entityId: r.entity_id, orderNumber: r.order_number, createdAt: r.at }))
}

// ---- detail ----

type OrderRow = {
  id: number; number: string; customer_id: number; contact_id: number | null; source: OrderSource; title: string
  due_date: string | null; artwork_status: ArtworkStatus; po_required: 0 | 1; authorized_at: string | null
  authorized_by: number | null; production_status: ProductionStatus; assignee_id: number | null
  estimated_total_cents: number | null; invoice_ref: string | null; payment_ref: string | null; state: OrderState
  created_at: string; updated_at: string
}

export const getOrderByNumber = (db: D1Database, number: string) =>
  db.prepare('SELECT * FROM orders WHERE number = ?').bind(number).first<OrderRow>()

const latestPoFor = async (db: D1Database, orderId: number) =>
  db.prepare('SELECT id, status FROM purchase_orders WHERE order_id = ? ORDER BY id DESC LIMIT 1').bind(orderId).first<{ id: number; status: PoStatus }>()

export const toGateOrder = (o: OrderRow): GateOrder => ({
  state: o.state,
  artworkStatus: o.artwork_status,
  poRequired: o.po_required === 1,
  authorizedAt: o.authorized_at,
})

export async function getOrderDetail(db: D1Database, number: string): Promise<(Omit<OrderDetailResponse, 'gate'> & { gateInput: { order: GateOrder; latestPo: GatePo } }) | null> {
  const o = await getOrderByNumber(db, number)
  if (!o) return null
  const [customer, contact, items, estimate, pos, notes, activity] = await Promise.all([
    db.prepare('SELECT id, name, kind, email, phone FROM customers WHERE id = ?').bind(o.customer_id).first<OrderDetailResponse['customer']>(),
    o.contact_id === null
      ? null
      : db.prepare('SELECT id, name, email, phone, title FROM customer_contacts WHERE id = ?').bind(o.contact_id).first<NonNullable<OrderDetailResponse['contact']>>(),
    db.prepare('SELECT id, product, garment_color, method, sizes, quantity, unit_price_cents, notes FROM order_items WHERE order_id = ? ORDER BY id').bind(o.id)
      .all<{ id: number; product: string; garment_color: string | null; method: Method; sizes: string | null; quantity: number; unit_price_cents: number; notes: string | null }>(),
    db.prepare('SELECT id, version, inputs, lines, total_cents, status, created_at FROM estimates WHERE order_id = ? ORDER BY version DESC LIMIT 1').bind(o.id)
      .first<{ id: number; version: number; inputs: string; lines: string; total_cents: number; status: NonNullable<OrderDetailResponse['latestEstimate']>['status']; created_at: string }>(),
    db.prepare('SELECT id, po_number, amount_cents, status, created_at, updated_at FROM purchase_orders WHERE order_id = ? ORDER BY id DESC').bind(o.id)
      .all<{ id: number; po_number: string | null; amount_cents: number | null; status: PoStatus; created_at: string; updated_at: string }>(),
    db.prepare(`SELECT n.id, n.body, u.name AS author_name, n.created_at FROM notes n LEFT JOIN users u ON u.id = n.author_id
        WHERE n.entity_type = 'order' AND n.entity_id = ? ORDER BY n.id DESC`).bind(o.id)
      .all<{ id: number; body: string; author_name: string | null; created_at: string }>(),
    db.prepare(`SELECT a.id, COALESCE(u.name, a.actor_kind) AS actor, a.action, a.before, a.after, a.at FROM activity_log a
        LEFT JOIN users u ON u.id = a.actor_id WHERE a.entity_type = 'order' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 50`).bind(o.id)
      .all<{ id: number; actor: string; action: string; before: string | null; after: string | null; at: string }>(),
  ])
  const json = (s: string | null) => (s === null ? null : (JSON.parse(s) as unknown))
  const latestPo = pos.results[0] ? { status: pos.results[0].status } : null
  return {
    order: {
      id: o.id, number: o.number, source: o.source, title: o.title, dueDate: o.due_date, artworkStatus: o.artwork_status,
      poRequired: o.po_required === 1, authorizedAt: o.authorized_at, authorizedBy: o.authorized_by,
      productionStatus: o.production_status, assigneeId: o.assignee_id, estimatedTotalCents: o.estimated_total_cents,
      invoiceRef: o.invoice_ref, paymentRef: o.payment_ref, state: o.state, createdAt: o.created_at, updatedAt: o.updated_at,
    },
    customer: customer as OrderDetailResponse['customer'],
    contact,
    items: items.results.map((i) => ({
      id: i.id, product: i.product, garmentColor: i.garment_color, method: i.method,
      sizes: json(i.sizes) as Record<string, number> | null, quantity: i.quantity, unitPriceCents: i.unit_price_cents, notes: i.notes,
    })),
    latestEstimate: estimate && {
      id: estimate.id, version: estimate.version, inputs: json(estimate.inputs), lines: json(estimate.lines),
      totalCents: estimate.total_cents, status: estimate.status, createdAt: estimate.created_at,
    },
    purchaseOrders: pos.results.map((p) => ({ id: p.id, poNumber: p.po_number, amountCents: p.amount_cents, status: p.status, createdAt: p.created_at, updatedAt: p.updated_at })),
    notes: notes.results.map((n) => ({ id: n.id, body: n.body, authorName: n.author_name, createdAt: n.created_at })),
    activity: activity.results.map((a) => ({ id: a.id, actor: a.actor, action: a.action, before: json(a.before), after: json(a.after), createdAt: a.at })),
    gateInput: { order: toGateOrder(o), latestPo },
  }
}

// ---- writes ----

export async function loadForProductionChange(db: D1Database, number: string) {
  const o = await getOrderByNumber(db, number)
  if (!o) return null
  const po = await latestPoFor(db, o.id)
  return { id: o.id, from: o.production_status, order: toGateOrder(o), latestPo: po ? { status: po.status } : null }
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
// Inserts only if the statement just before it changed a row (changes()), so a lost race logs nothing.
const LOG_IF_CHANGED = `INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, before, after)
  SELECT 'user', ?, 'order', ?, ?, ?, ? WHERE changes() > 0`

/**
 * THE only writer of orders.production_status for a user-requested change (the PO
 * auto-sync below is the other). Callers must have passed checkProductionTransition.
 * Returns false when the order moved under us (nothing logged, nothing changed).
 */
export async function applyProductionChange(db: D1Database, p: { orderId: number; actorId: number; from: ProductionStatus; to: ProductionStatus }) {
  const completing = p.to === 'completed'
  const [update] = await db.batch([
    db
      .prepare(`UPDATE orders SET production_status = ?, ${completing ? `state = 'completed', ` : ''}updated_at = ${NOW} WHERE id = ? AND production_status = ?`)
      .bind(p.to, p.orderId, p.from),
    db
      .prepare(LOG_IF_CHANGED)
      .bind(p.actorId, p.orderId, 'production_status_changed', JSON.stringify({ production_status: p.from }), JSON.stringify({ production_status: p.to, ...(completing ? { state: 'completed' } : {}) })),
  ])
  return (update?.meta.changes ?? 0) > 0
}

export async function loadForPoChange(db: D1Database, number: string, poId: number) {
  const o = await getOrderByNumber(db, number)
  if (!o) return null
  const po = await db.prepare('SELECT id, status FROM purchase_orders WHERE id = ? AND order_id = ?').bind(poId, o.id).first<{ id: number; status: PoStatus }>()
  if (!po) return null
  const latest = await latestPoFor(db, o.id)
  return { orderId: o.id, productionStatus: o.production_status, order: toGateOrder(o), po, latestPoId: latest?.id ?? po.id, latestPo: latest ? { status: latest.status } : null }
}

/** Updates the PO and, when `syncTo` is set, the awaiting_* production status, plus one activity row, in one batch. */
export async function applyPoChange(
  db: D1Database,
  p: { orderId: number; poId: number; actorId: number; from: PoStatus; to: PoStatus; productionFrom: ProductionStatus; syncTo: ProductionStatus | null },
) {
  const before = { po_id: p.poId, po_status: p.from, ...(p.syncTo ? { production_status: p.productionFrom } : {}) }
  const after = { po_id: p.poId, po_status: p.to, ...(p.syncTo ? { production_status: p.syncTo } : {}) }
  const stmts = [
    db.prepare(`UPDATE purchase_orders SET status = ?, updated_at = ${NOW} WHERE id = ? AND status = ?`).bind(p.to, p.poId, p.from),
    db.prepare(LOG_IF_CHANGED).bind(p.actorId, p.orderId, 'po_status_changed', JSON.stringify(before), JSON.stringify(after)),
  ]
  if (p.syncTo) {
    stmts.push(
      db
        .prepare(`UPDATE orders SET production_status = ?, updated_at = ${NOW} WHERE id = ? AND production_status = ? AND (SELECT status FROM purchase_orders WHERE id = ?) = ?`)
        .bind(p.syncTo, p.orderId, p.productionFrom, p.poId, p.to),
    )
  }
  const [update] = await db.batch(stmts)
  return (update?.meta.changes ?? 0) > 0
}
