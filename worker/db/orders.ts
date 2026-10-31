// All SQL for the order screens. Every value is bound; the only interpolated
// fragments are the constants below (VIEW_WHERE, the readiness SQL) and generated "?,?" placeholder lists.
import { METHODS, PRODUCTION_STATUSES } from '../../shared/enums'
import type {
  ArtworkApproval, AuthorizationMethod, CustomerKind, ItemKind, Method, OrderArtworkStatus, OrderSource, OrderState,
  PaymentTerms, PoStatus, PrepStatus, ProductionStatus, QuoteStatus,
} from '../../shared/enums'
import type { ActivityAction, InquiryListRow, OrderCounts, OrderDetailResponse, OrderListRow, OrderView } from '../../shared/api'
import type { DashInquiry, DashOrder } from '../domain/dashboard'
import type { ReadinessInput } from '../domain/readiness'

// ---- readiness in SQL ----
// The SQL twin of domain/readiness.ts, correlated on the `orders` row (an UPDATE's target, or `FROM orders`).
// Re-asserted inside writes because routes read before they write. tests/api/gate-parity.test.ts walks the
// input space and fails if these and readiness() ever disagree. Every predicate is NULL-safe (IS, EXISTS),
// because a NULL inside `CASE WHEN NOT …` would silently fall through.

// "Current" quote = highest version; "latest" PO = highest id.
const CURRENT_QUOTE_ID = `(SELECT cq.id FROM quotes cq WHERE cq.order_id = orders.id ORDER BY cq.version DESC LIMIT 1)`
const QUOTE_OK = `EXISTS (SELECT 1 FROM quotes q WHERE q.id = ${CURRENT_QUOTE_ID} AND q.status = 'accepted'
  AND q.items_revision = orders.items_revision
  AND EXISTS (SELECT 1 FROM quote_items qi WHERE qi.quote_id = q.id AND qi.kind = 'product'))`
const LATEST_PO_STATUS = `(SELECT status FROM purchase_orders WHERE order_id = orders.id ORDER BY id DESC LIMIT 1)`
// Direct authorization cannot substitute for a required PO.
const AUTH_OK = `((orders.po_required = 0 AND orders.authorized_at IS NOT NULL AND trim(orders.authorized_at) <> '') OR (orders.po_required = 1 AND ${LATEST_PO_STATUS} IS 'approved'))`
// A design = an artwork lineage on this order; its current version = the highest version attached to the order.
const CURRENT_ARTWORK = `artwork a WHERE a.order_id = orders.id
  AND a.version = (SELECT MAX(b.version) FROM artwork b WHERE b.lineage_id = a.lineage_id AND b.order_id = orders.id)`
/** SQL twin of orderArtworkStatus. A lineage always has a version here, so "missing version" can't occur in SQL. */
export const ARTWORK_STATUS = `(CASE WHEN orders.artwork_required = 0 THEN 'not_required'
  WHEN NOT EXISTS (SELECT 1 FROM ${CURRENT_ARTWORK}) THEN 'not_received'
  WHEN EXISTS (SELECT 1 FROM ${CURRENT_ARTWORK} AND a.approval_status = 'changes_requested') THEN 'changes_requested'
  WHEN EXISTS (SELECT 1 FROM ${CURRENT_ARTWORK} AND a.approval_status = 'under_review') THEN 'under_review'
  ELSE 'approved' END)`
const ARTWORK_OK = `(${ARTWORK_STATUS} IN ('approved','not_required'))`
// ponytail: purchases arrive in M3 (migration 0003); until then materials are met only when not required.
const MATERIALS_OK = `(orders.materials_required = 0)`
const PREP_OK = `(orders.prep_status IN ('ready','not_required'))`
/** SQL twin of readiness().ready. */
export const GATE_OK = `(orders.state = 'active' AND ${QUOTE_OK} AND ${AUTH_OK} AND ${ARTWORK_OK} AND ${MATERIALS_OK} AND ${PREP_OK})`
/** SQL twin of readiness().preProductionStatus: the first unmet item, in readiness's fixed order. */
export const PRE_PRODUCTION = `(CASE WHEN NOT ${QUOTE_OK} THEN 'awaiting_quote'
  WHEN NOT ${AUTH_OK} THEN 'awaiting_authorization'
  WHEN NOT ${ARTWORK_OK} THEN 'awaiting_artwork'
  WHEN NOT ${MATERIALS_OK} THEN 'awaiting_materials'
  WHEN NOT ${PREP_OK} THEN 'awaiting_preparation'
  ELSE 'ready' END)`
const PRE_PRODUCTION_STATUSES = PRODUCTION_STATUSES.filter((s) => s.startsWith('awaiting_') || s === 'ready')
const PRE_PRODUCTION_LIST = PRE_PRODUCTION_STATUSES.map((s) => `'${s}'`).join(',')

type BaseRow = {
  id: number
  number: string
  customer_name: string
  customer_kind: CustomerKind
  title: string
  artwork_status: OrderArtworkStatus
  po_required: 0 | 1
  production_status: ProductionStatus
  state: OrderState
  due_date: string | null
  latest_po_status: PoStatus | null
  latest_po_amount: number | null
  quote_status: QuoteStatus | null
  quote_total_cents: number | null
  quote_sent_at: string | null
  created_at: string
  version: number
  methods: string | null
  total_qty: number
}

const CURRENT_QUOTE = (expr: string) => `(SELECT ${expr} FROM quotes cq WHERE cq.order_id = orders.id ORDER BY cq.version DESC LIMIT 1)`
const BASE = `SELECT orders.id, orders.number, c.name AS customer_name, c.kind AS customer_kind, orders.title, ${ARTWORK_STATUS} AS artwork_status,
  orders.po_required, orders.production_status, orders.state, orders.due_date,
  (SELECT p.status FROM purchase_orders p WHERE p.order_id = orders.id ORDER BY p.id DESC LIMIT 1) AS latest_po_status,
  (SELECT p.amount_cents FROM purchase_orders p WHERE p.order_id = orders.id ORDER BY p.id DESC LIMIT 1) AS latest_po_amount,
  ${CURRENT_QUOTE('cq.status')} AS quote_status,
  ${CURRENT_QUOTE('cq.total_cents')} AS quote_total_cents,
  ${CURRENT_QUOTE('COALESCE(cq.sent_at, cq.created_at)')} AS quote_sent_at,
  orders.created_at, orders.version,
  (SELECT group_concat(DISTINCT i.method) FROM order_items i WHERE i.order_id = orders.id AND i.kind = 'product') AS methods,
  (SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i WHERE i.order_id = orders.id AND i.kind = 'product') AS total_qty
  FROM orders JOIN customers c ON c.id = orders.customer_id`

// Predicates over the BASE columns. 'inquiries' is counted from its own table.
const VIEW_WHERE: Record<Exclude<OrderView, 'inquiries'>, string> = {
  active: `state = 'active'`,
  waiting_po: `state = 'active' AND po_required = 1 AND (latest_po_status IS NULL OR latest_po_status <> 'approved')`,
  waiting_artwork: `state = 'active' AND artwork_status NOT IN ('approved','not_required')`,
  in_production: `state = 'active' AND production_status IN ('in_production','quality_control')`,
  // Pickup records arrive in M5; until then a finished, still-active order is the one waiting for pickup.
  ready: `state = 'active' AND production_status = 'production_complete'`,
  completed: `state = 'closed'`,
}

// Never note bodies or authorization notes; `reason` is the staff-typed cancel/revoke reason, shown in the history.
const ACTIVITY_KEYS = ['production_status', 'state', 'po_status', 'po_id', 'artwork_status', 'reason', 'items_revision', 'quote_version',
  'quote_status', 'order_number', 'repeat_of', 'authorization_method', 'fields',
  'title', 'due_date', 'contact_id', 'source', 'po_required', 'payment_terms', 'artwork_required', 'materials_required', 'assignee_id']

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
    version: r.version,
    quote: r.quote_status === null ? null : { status: r.quote_status, totalCents: r.quote_total_cents ?? 0 },
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
    quoteStatus: r.quote_status,
    createdAt: r.created_at,
    quoteSentAt: r.quote_sent_at,
  }))
}

/** When each order last finished production (production_complete), read from the activity log. */
export async function readyForPickupSince(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT entity_id, MAX(at) AS at FROM activity_log
       WHERE entity_type = 'order' AND json_extract(after, '$.production_status') = 'production_complete' GROUP BY entity_id`,
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
    .prepare(`SELECT order_id, product, quantity FROM order_items WHERE kind = 'product' AND order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY id`)
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
  due_date: string | null; artwork_required: 0 | 1; po_required: 0 | 1; authorized_at: string | null; authorized_by: number | null
  authorization_method: AuthorizationMethod | null; authorization_notes: string | null; items_revision: number
  payment_terms: PaymentTerms; materials_required: 0 | 1; prep_status: PrepStatus
  production_status: ProductionStatus; assignee_id: number | null
  invoice_ref: string | null; payment_ref: string | null; state: OrderState; version: number
  created_at: string; updated_at: string
  artwork_status: OrderArtworkStatus // derived (ARTWORK_STATUS), not a column
}

export const getOrderByNumber = (db: D1Database, number: string) =>
  db.prepare(`SELECT orders.*, ${ARTWORK_STATUS} AS artwork_status FROM orders WHERE number = ?`).bind(number).first<OrderRow>()

const latestPoFor = async (db: D1Database, orderId: number) =>
  db.prepare('SELECT id, status FROM purchase_orders WHERE order_id = ? ORDER BY id DESC LIMIT 1').bind(orderId).first<{ id: number; status: PoStatus }>()

/** Everything readiness() needs, read from the database with the same definitions as the SQL twin above. */
export async function readinessInput(db: D1Database, o: OrderRow): Promise<ReadinessInput> {
  const [quote, designs, po] = await Promise.all([
    db.prepare(`SELECT q.status, q.items_revision,
        (SELECT COUNT(*) FROM quote_items qi WHERE qi.quote_id = q.id AND qi.kind = 'product') AS product_lines
        FROM quotes q WHERE q.order_id = ? ORDER BY q.version DESC LIMIT 1`).bind(o.id)
      .first<{ status: QuoteStatus; items_revision: number; product_lines: number }>(),
    db.prepare(`SELECT a.id, a.file_id, a.approval_status FROM artwork a WHERE a.order_id = ?1
        AND a.version = (SELECT MAX(b.version) FROM artwork b WHERE b.lineage_id = a.lineage_id AND b.order_id = ?1) ORDER BY a.lineage_id`).bind(o.id)
      .all<{ id: number; file_id: number; approval_status: ArtworkApproval }>(),
    latestPoFor(db, o.id),
  ])
  return {
    state: o.state,
    // Product lines only: a charge-only snapshot is an empty quote (M0 review, carried into M1).
    quote: quote && { status: quote.status, itemsRevision: quote.items_revision, lineCount: quote.product_lines },
    itemsRevision: o.items_revision,
    artworkRequired: o.artwork_required === 1,
    designs: designs.results.map((d) => ({ currentVersion: { id: d.id, fileId: d.file_id, approval: d.approval_status } })),
    poRequired: o.po_required === 1,
    latestPo: po ? { status: po.status } : null,
    authorizedAt: o.authorized_at,
    materialsRequired: o.materials_required === 1,
    purchases: [], // ponytail: order purchases arrive in M3
    prepStatus: o.prep_status,
  }
}

type ItemRow = {
  id: number; kind: ItemKind; description: string | null; product: string | null; garment_color: string | null; method: Method | null
  sizes: string | null; quantity: number; unit_price_cents: number
}
const json = (s: string | null) => (s === null ? null : (JSON.parse(s) as unknown))
const toItem = (i: ItemRow) => ({
  id: i.id, kind: i.kind, description: i.description, product: i.product, garmentColor: i.garment_color, method: i.method,
  sizes: json(i.sizes) as Record<string, number> | null, quantity: i.quantity, unitPriceCents: i.unit_price_cents,
})

export async function getOrderDetail(db: D1Database, number: string): Promise<(Omit<OrderDetailResponse, 'gate' | 'readiness'> & { readinessInput: ReadinessInput }) | null> {
  const o = await getOrderByNumber(db, number)
  if (!o) return null
  const [customer, contact, items, quote, pos, notes, activity, input] = await Promise.all([
    db.prepare('SELECT id, name, kind, email, phone FROM customers WHERE id = ?').bind(o.customer_id).first<OrderDetailResponse['customer']>(),
    o.contact_id === null
      ? null
      : db.prepare('SELECT id, name, email, phone, title FROM customer_contacts WHERE id = ?').bind(o.contact_id).first<NonNullable<OrderDetailResponse['contact']>>(),
    db.prepare('SELECT id, kind, description, product, garment_color, method, sizes, quantity, unit_price_cents, notes FROM order_items WHERE order_id = ? ORDER BY id').bind(o.id)
      .all<ItemRow & { notes: string | null }>(),
    db.prepare(`SELECT id, version, status, items_revision, subtotal_cents, charges_cents, discounts_cents, total_cents, created_at, sent_at, decided_at
        FROM quotes WHERE order_id = ? ORDER BY version DESC LIMIT 1`).bind(o.id)
      .first<{ id: number; version: number; status: QuoteStatus; items_revision: number; subtotal_cents: number; charges_cents: number
        discounts_cents: number; total_cents: number; created_at: string; sent_at: string | null; decided_at: string | null }>(),
    db.prepare('SELECT id, po_number, amount_cents, status, created_at, updated_at FROM purchase_orders WHERE order_id = ? ORDER BY id DESC').bind(o.id)
      .all<{ id: number; po_number: string | null; amount_cents: number | null; status: PoStatus; created_at: string; updated_at: string }>(),
    db.prepare(`SELECT n.id, n.body, u.name AS author_name, n.created_at FROM notes n LEFT JOIN users u ON u.id = n.author_id
        WHERE n.entity_type = 'order' AND n.entity_id = ? ORDER BY n.id DESC`).bind(o.id)
      .all<{ id: number; body: string; author_name: string | null; created_at: string }>(),
    db.prepare(`SELECT a.id, COALESCE(u.name, a.actor_kind) AS actor, a.action, a.before, a.after, a.at FROM activity_log a
        LEFT JOIN users u ON u.id = a.actor_id WHERE a.entity_type = 'order' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 50`).bind(o.id)
      .all<{ id: number; actor: string; action: string; before: string | null; after: string | null; at: string }>(),
    readinessInput(db, o),
  ])
  const quoteItems = quote
    ? (await db.prepare('SELECT id, kind, description, product, garment_color, method, sizes, quantity, unit_price_cents, line_total_cents FROM quote_items WHERE quote_id = ? ORDER BY position')
        .bind(quote.id).all<ItemRow & { line_total_cents: number }>()).results
    : []
  // Activity payloads are an allowlist: anything else stored in the JSON never leaves the server.
  const payload = (s: string | null) => {
    const v = json(s)
    if (v === null || typeof v !== 'object') return null
    return Object.fromEntries(Object.entries(v).filter(([k]) => ACTIVITY_KEYS.includes(k)))
  }
  return {
    order: {
      id: o.id, number: o.number, source: o.source, title: o.title, dueDate: o.due_date,
      artworkStatus: o.artwork_status, artworkRequired: o.artwork_required === 1,
      poRequired: o.po_required === 1, authorizedAt: o.authorized_at, authorizedBy: o.authorized_by,
      authorizationMethod: o.authorization_method, authorizationNotes: o.authorization_notes, itemsRevision: o.items_revision,
      paymentTerms: o.payment_terms, materialsRequired: o.materials_required === 1, prepStatus: o.prep_status,
      productionStatus: o.production_status, assigneeId: o.assignee_id,
      invoiceRef: o.invoice_ref, paymentRef: o.payment_ref, state: o.state, version: o.version, createdAt: o.created_at, updatedAt: o.updated_at,
    },
    customer: customer as OrderDetailResponse['customer'],
    contact,
    items: items.results.map((i) => ({ ...toItem(i), notes: i.notes })),
    quote: quote && {
      id: quote.id, version: quote.version, status: quote.status, itemsRevision: quote.items_revision,
      subtotalCents: quote.subtotal_cents, chargesCents: quote.charges_cents, discountsCents: quote.discounts_cents, totalCents: quote.total_cents,
      createdAt: quote.created_at, sentAt: quote.sent_at, decidedAt: quote.decided_at,
      items: quoteItems.map((i) => ({ ...toItem(i), lineTotalCents: i.line_total_cents })),
    },
    purchaseOrders: pos.results.map((p) => ({ id: p.id, poNumber: p.po_number, amountCents: p.amount_cents, status: p.status, createdAt: p.created_at, updatedAt: p.updated_at })),
    notes: notes.results.map((n) => ({ id: n.id, body: n.body, authorName: n.author_name, createdAt: n.created_at })),
    activity: activity.results.map((a) => ({ id: a.id, actor: a.actor, action: a.action, before: payload(a.before), after: payload(a.after), createdAt: a.at })),
    readinessInput: input,
  }
}

// ---- writes ----

export async function loadForProductionChange(db: D1Database, number: string) {
  const o = await getOrderByNumber(db, number)
  if (!o) return null
  return { id: o.id, from: o.production_status, state: o.state, version: o.version, input: await readinessInput(db, o) }
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
// Inserts only if the statement just before it changed a row (changes()), so a lost race logs nothing.
const LOG_IF_CHANGED = `INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, before, after)
  SELECT 'user', ?, 'order', ?, ?, ?, ? WHERE changes() > 0`

/**
 * THE only writer of orders.production_status for a user-requested change (rederive() below is the
 * other). Callers must have passed checkOrderProductionMove. The readiness the move depended on is
 * re-asserted in the UPDATE itself: a start needs the full gate, a move between pre-production statuses
 * must land on the derived one. Returns false when the order moved or readiness no longer holds
 * (nothing logged, nothing changed).
 */
export async function applyProductionChange(db: D1Database, p: { orderId: number; actorId: number; from: ProductionStatus; to: ProductionStatus; expectedVersion: number }) {
  const guard = p.to === 'in_production' ? ` AND ${GATE_OK}`
    : (PRE_PRODUCTION_STATUSES as readonly string[]).includes(p.to) ? ` AND ${PRE_PRODUCTION} = ?` : ''
  const binds: (string | number)[] = [p.to, p.orderId, p.from, p.expectedVersion, ...(guard.endsWith('?') ? [p.to] : [])]
  const [update] = await db.batch([
    db
      .prepare(`UPDATE orders SET production_status = ?, version = version + 1, updated_at = ${NOW} WHERE id = ? AND production_status = ? AND version = ? AND state = 'active'${guard}`)
      .bind(...binds),
    db
      .prepare(LOG_IF_CHANGED)
      .bind(p.actorId, p.orderId, 'production_status_changed', JSON.stringify({ production_status: p.from }), JSON.stringify({ production_status: p.to })),
  ])
  return (update?.meta.changes ?? 0) > 0
}

export async function loadForPoChange(db: D1Database, number: string, poId: number) {
  const o = await getOrderByNumber(db, number)
  if (!o) return null
  const po = await db.prepare('SELECT id, status FROM purchase_orders WHERE id = ? AND order_id = ?').bind(poId, o.id).first<{ id: number; status: PoStatus }>()
  return po && { orderId: o.id, version: o.version, po }
}

/**
 * Updates the PO (guarded by its previous status and the order's version), bumps the order's version, logs, then
 * re-derives the pre-production status from readiness at write time (rederive). Each statement after the first runs
 * only if the one before it changed a row, so a lost race changes and logs nothing. Every applied PO change bumps the
 * version, even when the production status stays, so an order write from before it is refused (Codex review of cce1dc9).
 * Returns whether it applied, and the persisted production status and version.
 */
export async function applyPoChange(db: D1Database, p: { orderId: number; poId: number; actorId: number; version: number; from: PoStatus; to: PoStatus }) {
  const results = await db.batch([
    db.prepare(`UPDATE purchase_orders SET status = ?, updated_at = ${NOW} WHERE id = ? AND order_id = ? AND status = ? AND ${GUARD}`)
      .bind(p.to, p.poId, p.orderId, p.from, p.orderId, p.version),
    db.prepare(`UPDATE orders SET version = version + 1, updated_at = ${NOW} WHERE id = ? AND version = ? AND changes() > 0`).bind(p.orderId, p.version),
    db.prepare(LOG_IF_CHANGED).bind(p.actorId, p.orderId, 'po_status_changed', JSON.stringify({ po_id: p.poId, po_status: p.from }), JSON.stringify({ po_id: p.poId, po_status: p.to })),
    ...rederive(db, p.orderId, p.actorId, 'po_sync'),
  ])
  const row = await db.prepare('SELECT production_status, version FROM orders WHERE id = ?').bind(p.orderId).first<{ production_status: ProductionStatus; version: number }>()
  return { changed: (results[1]?.meta.changes ?? 0) > 0, productionStatus: row!.production_status, version: row!.version }
}

// ---- the re-derive ----

// A pre-production order whose stored status isn't what readiness says now.
const DERIVABLE = `orders.state = 'active' AND orders.production_status IN (${PRE_PRODUCTION_LIST}) AND orders.production_status <> ${PRE_PRODUCTION}`
type Stmt = ReturnType<D1Database['prepare']>
type Value = string | number | null

/**
 * THE awaiting-status re-derive (AGENTS.md's second production_status writer). Every write that can change
 * readiness appends these two statements right after its own activity INSERT, so they run only when that row
 * was written (changes() > 0): a refused write moves nothing. A pre-production order (awaiting_* or ready)
 * moves to what readiness says now, with its own activity row; in_production and later, and inactive orders,
 * never move. The log goes first so it can read the status before the move; both see the same row.
 */
export function rederive(db: D1Database, orderId: number, actorId: number, reason: string): Stmt[] {
  return [
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, before, after)
      SELECT 'user', ?, 'order', id, 'production_status_changed', json_object('production_status', production_status),
        json_object('production_status', ${PRE_PRODUCTION}, 'reason', ?)
      FROM orders WHERE id = ? AND changes() > 0 AND ${DERIVABLE}`).bind(actorId, reason, orderId),
    db.prepare(`UPDATE orders SET production_status = ${PRE_PRODUCTION}, version = version + 1, updated_at = ${NOW}
      WHERE id = ? AND changes() > 0 AND ${DERIVABLE}`).bind(orderId),
  ]
}

// ---- order writes (M1c) ----
// Every write is one batch: [data statements…, the order UPDATE with the version guard, its activity row, the re-derive].
// The data statements come first and each carries GUARD, so they see the version before the bump and all apply or
// none do; the order UPDATE then bumps it. A stale version changes nothing, logs nothing, and the caller gets null.

const GUARD = `EXISTS (SELECT 1 FROM orders g WHERE g.id = ? AND g.version = ?)`
const toJson = (v: object | undefined) => (v === undefined ? null : JSON.stringify(v))

export type OrderStateRow = { number: string; version: number; productionStatus: ProductionStatus; itemsRevision: number; state: OrderState }
export async function orderState(db: D1Database, by: { id: number } | { number: string }): Promise<OrderStateRow | null> {
  const r = await db.prepare(`SELECT number, version, production_status, items_revision, state FROM orders WHERE ${'id' in by ? 'id' : 'number'} = ?`)
    .bind('id' in by ? by.id : by.number)
    .first<{ number: string; version: number; production_status: ProductionStatus; items_revision: number; state: OrderState }>()
  return r && { number: r.number, version: r.version, productionStatus: r.production_status, itemsRevision: r.items_revision, state: r.state }
}

type OrderWrite = {
  orderId: number; version: number; actorId: number; action: ActivityAction; before?: object; after?: object
  /** `column = expr` fragments, each a constant from this file (never user input), with their binds. */
  set?: [sql: string, ...binds: Value[]][]
  /** An extra condition on the order UPDATE (a constant from this file, correlated on `orders`), with its binds. */
  where?: [sql: string, ...binds: Value[]]
  data?: Stmt[]
}
async function orderWrite(db: D1Database, w: OrderWrite): Promise<OrderStateRow | null> {
  const set = w.set ?? []
  const data = w.data ?? []
  const results = await db.batch([
    ...data,
    db.prepare(`UPDATE orders SET ${set.map(([sql]) => `${sql}, `).join('')}version = version + 1, updated_at = ${NOW} WHERE id = ? AND version = ?${w.where ? ` AND ${w.where[0]}` : ''}`)
      .bind(...set.flatMap(([, ...binds]) => binds), w.orderId, w.version, ...(w.where?.slice(1) ?? [])),
    db.prepare(LOG_IF_CHANGED).bind(w.actorId, w.orderId, w.action, toJson(w.before), toJson(w.after)),
    ...rederive(db, w.orderId, w.actorId, w.action),
  ])
  return (results[data.length]?.meta.changes ?? 0) > 0 ? orderState(db, { id: w.orderId }) : null
}

export type ItemWrite = {
  id?: number; kind: ItemKind; description: string | null; product: string | null; garmentColor: string | null; method: Method | null
  sizes: Record<string, number> | null; quantity: number; unitPriceCents: number; notes: string | null
}
export type QuoteLineWrite = Omit<ItemWrite, 'id' | 'notes'> & { lineTotalCents: number }
export type QuoteTotals = { subtotalCents: number; chargesCents: number; discountsCents: number; totalCents: number }
const ITEM_COLS = 'kind, description, product, garment_color, method, sizes, quantity, unit_price_cents'
const itemBinds = (i: Omit<ItemWrite, 'id' | 'notes'>): Value[] =>
  [i.kind, i.description, i.product, i.garmentColor, i.method, i.sizes ? JSON.stringify(i.sizes) : null, i.quantity, i.unitPriceCents]

// Removed lines are deleted and retained ones updated in place before any new line is inserted, so a new line can
// never be handed a retained line's id (delete-all-then-insert could, when the retained line was the table's last row).
const ITEM_SET = `${ITEM_COLS.split(', ').map((c) => `${c} = ?`).join(', ')}, notes = ?`
const replaceItemsStmts = (db: D1Database, orderId: number, version: number, items: ItemWrite[]) => [
  db.prepare(`DELETE FROM order_items WHERE order_id = ? AND id NOT IN (SELECT value FROM json_each(?)) AND ${GUARD}`)
    .bind(orderId, JSON.stringify(items.flatMap((i) => (i.id === undefined ? [] : [i.id]))), orderId, version),
  ...items.filter((i) => i.id !== undefined).map((i) => db.prepare(`UPDATE order_items SET ${ITEM_SET} WHERE id = ? AND order_id = ? AND ${GUARD}`)
    .bind(...itemBinds(i), i.notes, i.id!, orderId, orderId, version)),
  ...items.filter((i) => i.id === undefined).map((i) => db.prepare(`INSERT INTO order_items (order_id, ${ITEM_COLS}, notes) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${GUARD}`)
    .bind(orderId, ...itemBinds(i), i.notes, orderId, version)),
]
const quoteLineStmts = (db: D1Database, quoteIdSql: string, quoteIdBinds: Value[], orderId: number, version: number, lines: QuoteLineWrite[]) =>
  lines.map((l, position) => db.prepare(`INSERT INTO quote_items (quote_id, position, ${ITEM_COLS}, line_total_cents)
      SELECT ${quoteIdSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${GUARD}`)
    .bind(...quoteIdBinds, position, ...itemBinds(l), l.lineTotalCents, orderId, version))

type Guarded = { orderId: number; version: number; actorId: number }

// Column names here are constants; the values are bound.
const HEADER_COLUMNS = {
  title: 'title', dueDate: 'due_date', contactId: 'contact_id', source: 'source', poRequired: 'po_required', paymentTerms: 'payment_terms',
  artworkRequired: 'artwork_required', materialsRequired: 'materials_required', assigneeId: 'assignee_id',
} as const
export type HeaderField = keyof typeof HEADER_COLUMNS
export type HeaderChange = Partial<Record<HeaderField, Value>>
// The contact is this order's customer's and not archived: re-checked inside the write, because routes read first.
const CONTACT_OK = `EXISTS (SELECT 1 FROM customer_contacts cc WHERE cc.id = ? AND cc.customer_id = orders.customer_id AND cc.archived_at IS NULL)`
/** Returns null on a stale version, or when the contact being set is no longer this customer's live contact. */
export function updateOrderHeader(db: D1Database, p: Guarded & { changes: HeaderChange; before: HeaderChange; noPurchasing: boolean }) {
  const keys = Object.keys(p.changes) as HeaderField[]
  const cols = (o: HeaderChange) => Object.fromEntries(keys.map((k) => [HEADER_COLUMNS[k], o[k] ?? null]))
  const contactId = p.changes.contactId
  return orderWrite(db, {
    ...p, action: p.noPurchasing ? 'no_purchasing_confirmed' : 'order_updated',
    where: typeof contactId === 'number' ? [CONTACT_OK, contactId] : undefined,
    set: keys.map((k) => [`${HEADER_COLUMNS[k]} = ?`, p.changes[k] ?? null]),
    before: cols(p.before), after: { ...cols(p.changes), fields: keys.map((k) => HEADER_COLUMNS[k]) },
  })
}

export function replaceItems(db: D1Database, p: Guarded & { items: ItemWrite[]; itemsRevision: { from: number; to: number } }) {
  return orderWrite(db, {
    ...p, action: 'items_replaced', data: replaceItemsStmts(db, p.orderId, p.version, p.items),
    set: [['items_revision = ?', p.itemsRevision.to]],
    before: { items_revision: p.itemsRevision.from }, after: { items_revision: p.itemsRevision.to },
  })
}

/** A new quote version from `lines` (optionally first replacing the order's items, for a duplicate), superseding `supersedeIds`. */
export function createQuote(db: D1Database, p: Guarded & {
  quoteVersion: number; itemsRevision: number; totals: QuoteTotals; lines: QuoteLineWrite[]; supersedeIds: number[]
  replaceItems?: ItemWrite[]; duplicateOf?: number
}) {
  const ids = p.supersedeIds
  return orderWrite(db, {
    ...p, action: 'quote_created',
    data: [
      ...(p.replaceItems ? replaceItemsStmts(db, p.orderId, p.version, p.replaceItems) : []),
      ...(ids.length ? [db.prepare(`UPDATE quotes SET status = 'superseded' WHERE id IN (${ids.map(() => '?').join(',')}) AND order_id = ?
          AND status IN ('draft','sent','accepted') AND ${GUARD}`).bind(...ids, p.orderId, p.orderId, p.version)] : []),
      db.prepare(`INSERT INTO quotes (order_id, version, items_revision, subtotal_cents, charges_cents, discounts_cents, total_cents, created_by)
          SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${GUARD}`)
        .bind(p.orderId, p.quoteVersion, p.itemsRevision, p.totals.subtotalCents, p.totals.chargesCents, p.totals.discountsCents, p.totals.totalCents,
          p.actorId, p.orderId, p.version),
      ...quoteLineStmts(db, '(SELECT id FROM quotes WHERE order_id = ? AND version = ?)', [p.orderId, p.quoteVersion], p.orderId, p.version, p.lines),
    ],
    set: [['items_revision = ?', p.itemsRevision]],
    after: { quote_version: p.quoteVersion, items_revision: p.itemsRevision, ...(p.duplicateOf ? { reason: `duplicate_of_v${p.duplicateOf}` } : {}) },
  })
}

/** Re-snapshots a draft from the current items. The draft-only triggers back the route's check. */
export function refreshQuote(db: D1Database, p: Guarded & { quoteId: number; quoteVersion: number; itemsRevision: number; totals: QuoteTotals; lines: QuoteLineWrite[] }) {
  return orderWrite(db, {
    ...p, action: 'quote_refreshed',
    data: [
      db.prepare(`DELETE FROM quote_items WHERE quote_id = ? AND ${GUARD}`).bind(p.quoteId, p.orderId, p.version),
      ...quoteLineStmts(db, '?', [p.quoteId], p.orderId, p.version, p.lines),
      db.prepare(`UPDATE quotes SET items_revision = ?, subtotal_cents = ?, charges_cents = ?, discounts_cents = ?, total_cents = ?
          WHERE id = ? AND status = 'draft' AND ${GUARD}`)
        .bind(p.itemsRevision, p.totals.subtotalCents, p.totals.chargesCents, p.totals.discountsCents, p.totals.totalCents, p.quoteId, p.orderId, p.version),
    ],
    after: { quote_version: p.quoteVersion, items_revision: p.itemsRevision },
  })
}

export function changeQuoteStatus(db: D1Database, p: Guarded & { quoteId: number; quoteVersion: number; from: QuoteStatus; to: QuoteStatus }) {
  return orderWrite(db, {
    ...p, action: 'quote_status_changed',
    data: [db.prepare(`UPDATE quotes SET status = ?1, sent_at = CASE WHEN ?1 = 'sent' THEN ${NOW} ELSE sent_at END,
        decided_at = CASE WHEN ?1 IN ('accepted','declined') THEN ${NOW} ELSE decided_at END
        WHERE id = ?2 AND status = ?3 AND EXISTS (SELECT 1 FROM orders g WHERE g.id = ?4 AND g.version = ?5)`)
      .bind(p.to, p.quoteId, p.from, p.orderId, p.version)],
    before: { quote_version: p.quoteVersion, quote_status: p.from }, after: { quote_version: p.quoteVersion, quote_status: p.to },
  })
}

export function recordAuthorization(db: D1Database, p: Guarded & { method: AuthorizationMethod; notes: string | null; previous: AuthorizationMethod | null }) {
  return orderWrite(db, {
    ...p, action: 'authorization_recorded',
    set: [[`authorized_at = ${NOW}`], ['authorized_by = ?', p.actorId], ['authorization_method = ?', p.method], ['authorization_notes = ?', p.notes]],
    before: { authorization_method: p.previous }, after: { authorization_method: p.method },
  })
}

export function revokeAuthorization(db: D1Database, p: Guarded & { reason: string; previous: AuthorizationMethod | null }) {
  return orderWrite(db, {
    ...p, action: 'authorization_revoked',
    set: [['authorized_at = NULL'], ['authorized_by = NULL'], ['authorization_method = NULL'], ['authorization_notes = NULL']],
    before: { authorization_method: p.previous }, after: { reason: p.reason },
  })
}

/**
 * CANCEL_ORDER_SQL's pattern (productionSql.ts) without the M4 slot columns: a running job drops back to the
 * pre-production status readiness derives (the re-derive's own expression), so nothing stays "in production".
 */
export function cancelOrder(db: D1Database, p: Guarded & { reason: string; productionFrom: ProductionStatus; productionTo: ProductionStatus }) {
  return orderWrite(db, {
    ...p, action: 'order_cancelled',
    set: [[`state = 'cancelled'`], [`production_status = CASE WHEN production_status = 'in_production' THEN ${PRE_PRODUCTION} ELSE production_status END`]],
    before: { state: 'active', production_status: p.productionFrom }, after: { state: 'cancelled', production_status: p.productionTo, reason: p.reason },
  })
}

export function reopenOrder(db: D1Database, p: Guarded) {
  return orderWrite(db, { ...p, action: 'order_reopened', set: [[`state = 'active'`]], before: { state: 'cancelled' }, after: { state: 'active' } })
}

export async function addNote(db: D1Database, p: { orderId: number; actorId: number; body: string }) {
  await db.batch([
    db.prepare(`INSERT INTO notes (entity_type, entity_id, author_id, body) VALUES ('order', ?, ?, ?)`).bind(p.orderId, p.actorId, p.body),
    db.prepare(LOG_IF_CHANGED).bind(p.actorId, p.orderId, 'note_added', null, null),
  ])
}

// ---- new orders ----
// The year's counter row is created on first use (the remote counters table starts empty) and handed out
// atomically; the order INSERT reads the number back in the same batch, so a failed batch burns no number.
// A refused create burns none either: the upsert and every statement after it carry the same prerequisite (`ok`),
// so when it fails nothing runs, NEW_NUMBER (which would then name the previous order) is never used, and the
// function returns null. RAISE() is trigger-only in SQLite, hence a shared predicate rather than an abort.
// The INSERT … SELECT has its WHERE before ON CONFLICT (SQLite's upsert parsing rule); tests/d1 runs it on workerd.
const COUNTER_SQL = (ok: string) => `INSERT INTO counters (name, year, next) SELECT 'order', ?, 2 WHERE ${ok}
  ON CONFLICT (name, year) DO UPDATE SET next = next + 1 RETURNING next - 1 AS n`
/** The number just handed out, formatted like domain/orderNumber.formatOrderNumber (orders-write.test.ts checks they agree). */
export const NEW_NUMBER = `(SELECT printf('%d-%04d', year, next - 1) FROM counters WHERE name = 'order' AND year = ?)`
const counterN = (r: { results?: unknown[] } | undefined) => (r?.results?.[0] as { n: number } | undefined)?.n ?? null

export async function createOrder(db: D1Database, p: {
  year: number; actorId: number; customerId: number; contactId: number | null; source: OrderSource; title: string; dueDate: string | null
  poRequired: boolean; paymentTerms: PaymentTerms; artworkRequired: boolean; productionStatus: ProductionStatus; items: ItemWrite[]
}): Promise<number | null> {
  // The contact must be the customer's and not archived, re-checked here so a moved or archived contact can't slip in.
  const ok = `(? IS NULL OR EXISTS (SELECT 1 FROM customer_contacts cc WHERE cc.id = ? AND cc.customer_id = ? AND cc.archived_at IS NULL))`
  const okBinds = [p.contactId, p.contactId, p.customerId]
  const [counter] = await db.batch([
    db.prepare(COUNTER_SQL(ok)).bind(p.year, ...okBinds),
    db.prepare(`INSERT INTO orders (number, customer_id, contact_id, source, title, due_date, po_required, payment_terms, artwork_required, production_status, created_by)
        SELECT ${NEW_NUMBER}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${ok}`)
      .bind(p.year, p.customerId, p.contactId, p.source, p.title, p.dueDate, p.poRequired ? 1 : 0, p.paymentTerms, p.artworkRequired ? 1 : 0, p.productionStatus, p.actorId, ...okBinds),
    ...p.items.map((i) => db.prepare(`INSERT INTO order_items (order_id, ${ITEM_COLS}, notes) SELECT o.id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM orders o WHERE o.number = ${NEW_NUMBER} AND ${ok}`)
      .bind(...itemBinds(i), i.notes, p.year, ...okBinds)),
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
        SELECT 'user', ?, 'order', id, 'created', json_object('order_number', number, 'production_status', production_status) FROM orders WHERE number = ${NEW_NUMBER} AND ${ok}`)
      .bind(p.actorId, p.year, ...okBinds),
  ])
  return counterN(counter)
}

/**
 * A new order for the same customer with a copy of the source's items (no quotes, artwork, POs or authorization).
 * The contact is copied only while it is still the customer's live contact; otherwise nothing is created and no number
 * is used (null). An archived contact is refused rather than dropped, so staff pick the new contact on purpose.
 */
export async function repeatOrder(db: D1Database, p: { year: number; actorId: number; sourceId: number; source: OrderSource; dueDate: string | null; productionStatus: ProductionStatus }): Promise<number | null> {
  const ok = `EXISTS (SELECT 1 FROM orders src WHERE src.id = ? AND (src.contact_id IS NULL OR EXISTS (SELECT 1 FROM customer_contacts cc
    WHERE cc.id = src.contact_id AND cc.customer_id = src.customer_id AND cc.archived_at IS NULL)))`
  const [counter] = await db.batch([
    db.prepare(COUNTER_SQL(ok)).bind(p.year, p.sourceId),
    db.prepare(`INSERT INTO orders (number, customer_id, contact_id, source, title, due_date, po_required, payment_terms, artwork_required, production_status, created_by)
        SELECT ${NEW_NUMBER}, customer_id, contact_id, ?, title || ' (repeat)', ?, po_required, payment_terms, artwork_required, ?, ? FROM orders WHERE id = ? AND ${ok}`)
      .bind(p.year, p.source, p.dueDate, p.productionStatus, p.actorId, p.sourceId, p.sourceId),
    db.prepare(`INSERT INTO order_items (order_id, ${ITEM_COLS}, notes) SELECT n.id, ${ITEM_COLS.split(', ').map((c) => `i.${c}`).join(', ')}, i.notes
        FROM order_items i JOIN orders n ON n.number = ${NEW_NUMBER} WHERE i.order_id = ? AND ${ok} ORDER BY i.id`).bind(p.year, p.sourceId, p.sourceId),
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
        SELECT 'user', ?, 'order', n.id, 'created', json_object('order_number', n.number, 'repeat_of', s.number, 'production_status', n.production_status)
        FROM orders n JOIN orders s ON s.id = ? WHERE n.number = ${NEW_NUMBER} AND ${ok}`).bind(p.actorId, p.sourceId, p.year, p.sourceId),
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
        SELECT 'user', ?, 'order', ?, 'order_repeated', json_object('order_number', number) FROM orders WHERE number = ${NEW_NUMBER} AND ${ok}`)
      .bind(p.actorId, p.sourceId, p.year, p.sourceId),
  ])
  return counterN(counter)
}

// ---- reads for the writes ----

export const getCustomerDefaults = (db: D1Database, id: number) =>
  db.prepare('SELECT id, default_po_required, default_payment_terms FROM customers WHERE id = ?').bind(id)
    .first<{ id: number; default_po_required: 0 | 1; default_payment_terms: PaymentTerms }>()
// An archived contact can't be put on an order: the caller tells "archived" apart from "not this customer's".
export const getContactCustomer = (db: D1Database, contactId: number) =>
  db.prepare('SELECT customer_id, archived_at IS NOT NULL AS archived FROM customer_contacts WHERE id = ?').bind(contactId)
    .first<{ customer_id: number; archived: 0 | 1 }>()
export const isActiveUser = async (db: D1Database, id: number) =>
  (await db.prepare('SELECT 1 AS ok FROM users WHERE id = ? AND active = 1').bind(id).first<{ ok: number }>()) !== null

export async function listItems(db: D1Database, orderId: number): Promise<(ItemWrite & { id: number })[]> {
  const { results } = await db.prepare(`SELECT id, ${ITEM_COLS}, notes FROM order_items WHERE order_id = ? ORDER BY id`).bind(orderId)
    .all<ItemRow & { notes: string | null }>()
  return results.map((i) => ({ ...toItem(i), notes: i.notes }))
}
export async function listQuotes(db: D1Database, orderId: number) {
  const { results } = await db.prepare('SELECT id, version, status, items_revision FROM quotes WHERE order_id = ? ORDER BY version').bind(orderId)
    .all<{ id: number; version: number; status: QuoteStatus; items_revision: number }>()
  return results
}
export async function quoteLines(db: D1Database, quoteId: number) {
  const { results } = await db.prepare(`SELECT id, ${ITEM_COLS} FROM quote_items WHERE quote_id = ? ORDER BY position`).bind(quoteId).all<ItemRow>()
  return results.map(toItem)
}
