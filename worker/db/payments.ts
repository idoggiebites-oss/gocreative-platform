// SQL for payments, check collections and the order closing they drive (M5, migration 0006). Values are bound; the
// interpolated fragments are constants from this file. Every write is one batch (m5Write):
//   [data statements…] -> the order UPDATE (version + 1; only if the last data statement changed a row, and for order
//   writes only at the client's version) -> its activity row -> settle (closed = picked up AND paid, PHASE2_PLAN §4.2).
// Each statement after the first runs only if the one before it changed a row (changes()), so a refused or lost write
// changes and logs nothing. No re-derive: payments and pickups never change readiness, and a production_complete order
// is never re-derived.
import type { CheckStatus, CustomerKind, OrderState, PaymentMethod, PaymentTerms, ProductionStatus } from '../../shared/enums'
import type { ActivityAction, CheckRecord, PaymentRecord } from '../../shared/api'
import { COLLECT_CHECK_SQL, RECORD_PAYMENT_SQL } from './paymentSql'
import { GUARD, LOG_IF_CHANGED, NOW, type Stmt } from './orders'

// ---- the financial track in SQL (correlated on `orders`) ----
// The SQL twin of domain/payments.ts balance() as far as closing needs it. Agreed total = the highest-version accepted
// quote's total; NULL (no accepted quote) is never paid. Voided payments don't count. Migration 0006's
// pickups_release_* triggers spell out the same "paid" for the unpaid-release rule.
export const AGREED_TOTAL = `(SELECT q.total_cents FROM quotes q WHERE q.order_id = orders.id AND q.status = 'accepted' ORDER BY q.version DESC LIMIT 1)`
const RECEIVED = `(SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p WHERE p.order_id = orders.id AND p.voided_at IS NULL)`
const PAID = `COALESCE(${RECEIVED} >= ${AGREED_TOTAL}, 0)`
const PICKED_UP = `EXISTS (SELECT 1 FROM pickups pk WHERE pk.order_id = orders.id AND pk.picked_up_on IS NOT NULL)`
/** domain/payments.ts settledState for a non-cancelled order. */
const SETTLED = `(CASE WHEN ${PICKED_UP} AND ${PAID} THEN 'closed' ELSE 'active' END)`
const OUT_OF_STEP = `orders.state IN ('active','closed') AND orders.state <> ${SETTLED}`

/**
 * Closes the order when it is now picked up and paid, or makes a closed order active again when a void left it unpaid,
 * with an order_closed / order_reopened activity row. Runs only when the statement before it changed a row.
 */
function settle(db: D1Database, orderId: number, actorId: number, reason: string): Stmt[] {
  return [
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, before, after)
      SELECT 'user', ?, 'order', id, CASE ${SETTLED} WHEN 'closed' THEN 'order_closed' ELSE 'order_reopened' END,
        json_object('state', state), json_object('state', ${SETTLED}, 'reason', ?)
      FROM orders WHERE id = ? AND changes() > 0 AND ${OUT_OF_STEP}`).bind(actorId, reason, orderId),
    db.prepare(`UPDATE orders SET state = ${SETTLED}, updated_at = ${NOW} WHERE id = ? AND changes() > 0 AND ${OUT_OF_STEP}`).bind(orderId),
  ]
}

export type M5Write = {
  orderId: number; actorId: number
  /** The order version the client saw (re-checked by the order UPDATE); null for the check moves, which the check's own status guards. */
  version: number | null
  data: Stmt[]
  /** The write's own activity row; left out when a trigger (void, override) or COLLECT_CHECK_SQL writes it. */
  log?: { action: ActivityAction; before?: object; after?: object }
  /** Re-settle closed/active after a write that changes payments or the pickup; the string is the logged reason. */
  settle?: string
}
const json = (v: object | undefined) => (v === undefined ? null : JSON.stringify(v))
/** Returns whether the order UPDATE applied (so the whole write did), and each data statement's result. */
export async function m5Write(db: D1Database, w: M5Write) {
  const results = await db.batch([
    ...w.data,
    db.prepare(`UPDATE orders SET version = version + 1, updated_at = ${NOW} WHERE id = ?${w.version === null ? '' : ' AND version = ?'} AND changes() > 0`)
      .bind(w.orderId, ...(w.version === null ? [] : [w.version])),
    ...(w.log ? [db.prepare(LOG_IF_CHANGED).bind(w.actorId, w.orderId, w.log.action, json(w.log.before), json(w.log.after))] : []),
    ...(w.settle ? settle(db, w.orderId, w.actorId, w.settle) : []),
  ])
  return { applied: (results[w.data.length]?.meta.changes ?? 0) > 0, data: results.slice(0, w.data.length) }
}
const newId = (r: { results?: unknown[] } | undefined) => (r?.results?.[0] as { id: number } | undefined)?.id ?? null

// ---- reads ----

/** The agreed total (null without an accepted quote) and the amounts of the order's non-voided payments: balance()'s input. */
export async function balanceInput(db: D1Database, orderId: number) {
  const [agreed, amounts] = await Promise.all([
    db.prepare(`SELECT ${AGREED_TOTAL} AS cents FROM orders WHERE id = ?`).bind(orderId).first<{ cents: number | null }>(),
    db.prepare('SELECT amount_cents FROM payments WHERE order_id = ? AND voided_at IS NULL ORDER BY id').bind(orderId).all<{ amount_cents: number }>(),
  ])
  return { agreedCents: agreed?.cents ?? null, payments: amounts.results.map((r) => ({ amountCents: r.amount_cents })) }
}

type PaymentRow = {
  id: number; order_id: number; amount_cents: number; method: PaymentMethod; paid_on: string; notes: string | null; recorded_by_name: string | null
  check_collection_id: number | null; created_at: string; voided_at: string | null; voided_by_name: string | null; void_reason: string | null
}
const PAYMENT_SELECT = `SELECT p.id, p.order_id, p.amount_cents, p.method, p.paid_on, p.notes, u.name AS recorded_by_name, p.check_collection_id,
  p.created_at, p.voided_at, v.name AS voided_by_name, p.void_reason
  FROM payments p LEFT JOIN users u ON u.id = p.recorded_by LEFT JOIN users v ON v.id = p.voided_by`
const toPayment = (r: PaymentRow): PaymentRecord => ({
  id: r.id, amountCents: r.amount_cents, method: r.method, paidOn: r.paid_on, notes: r.notes, recordedBy: r.recorded_by_name,
  checkCollectionId: r.check_collection_id, createdAt: r.created_at,
  voided: r.voided_at === null ? null : { at: r.voided_at, by: r.voided_by_name, reason: r.void_reason ?? '' },
})
export async function listPayments(db: D1Database, orderId: number) {
  return (await db.prepare(`${PAYMENT_SELECT} WHERE p.order_id = ? ORDER BY p.id`).bind(orderId).all<PaymentRow>()).results.map(toPayment)
}
export async function getPayment(db: D1Database, orderId: number, paymentId: number) {
  const r = await db.prepare(`${PAYMENT_SELECT} WHERE p.id = ? AND p.order_id = ?`).bind(paymentId, orderId).first<PaymentRow>()
  return r && toPayment(r)
}
/** The stored payment under a request_id (any order), with what matchRetry compares. */
export async function paymentByRequestId(db: D1Database, requestId: string) {
  const r = await db.prepare(`${PAYMENT_SELECT} WHERE p.request_id = ?`).bind(requestId).first<PaymentRow>()
  return r && { ...toPayment(r), orderId: r.order_id }
}

export type CheckRow = {
  id: number; order_id: number; order_state: OrderState; order_number: string; order_title: string; order_due_date: string | null; customer_name: string; expected_cents: number; amount_received_cents: number | null
  check_number: string | null; status: CheckStatus; available_on: string | null; collected_at: string | null; collected_by_name: string | null
  deposited_on: string | null; cleared_on: string | null; notes: string | null; created_at: string; payment_id: number | null
}
const CHECK_SELECT = `SELECT k.id, k.order_id, o.state AS order_state, o.number AS order_number, o.title AS order_title, o.due_date AS order_due_date, c.name AS customer_name, k.expected_cents, k.amount_received_cents, k.check_number,
  k.status, k.available_on, k.collected_at, u.name AS collected_by_name, k.deposited_on, k.cleared_on, k.notes, k.created_at,
  (SELECT p.id FROM payments p WHERE p.check_collection_id = k.id) AS payment_id
  FROM check_collections k JOIN orders o ON o.id = k.order_id JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = k.collected_by`
export const toCheck = (r: CheckRow): CheckRecord => ({
  id: r.id, orderNumber: r.order_number, expectedCents: r.expected_cents, amountReceivedCents: r.amount_received_cents, checkNumber: r.check_number,
  status: r.status, availableOn: r.available_on, collectedAt: r.collected_at, collectedBy: r.collected_by_name, depositedOn: r.deposited_on,
  clearedOn: r.cleared_on, notes: r.notes, createdAt: r.created_at, paymentId: r.payment_id,
})
export async function listOrderChecks(db: D1Database, orderId: number) {
  return (await db.prepare(`${CHECK_SELECT} WHERE k.order_id = ? ORDER BY k.id`).bind(orderId).all<CheckRow>()).results
}
export const getCheck = (db: D1Database, checkId: number) => db.prepare(`${CHECK_SELECT} WHERE k.id = ?`).bind(checkId).first<CheckRow>()
/** Every check not yet cleared, across orders: the Payments page and the dashboard. */
export async function listOpenChecks(db: D1Database) {
  return (await db.prepare(`${CHECK_SELECT} WHERE k.status <> 'cleared' ORDER BY k.available_on IS NULL, k.available_on, k.id`).all<CheckRow>()).results
}

export type OutstandingCandidate = {
  id: number; number: string; customer_name: string; customer_kind: CustomerKind; title: string; payment_terms: PaymentTerms
  payment_due_on: string | null; version: number; production_status: ProductionStatus; agreed_cents: number | null
  ready_on: string | null; notified_on: string | null; picked_up_on: string | null; collection_status: CheckStatus | null; open_checks: string | null
}
/**
 * Active orders whose production is complete (the money is due: at pickup, or after it), with what the Payments page
 * needs and each one's non-voided payment amounts. The route keeps those balance() says still owe.
 * ponytail: loads every finished active order; a small shop has dozens. Filter in SQL if it ever has thousands.
 */
export async function listOutstandingCandidates(db: D1Database) {
  const [orders, amounts] = await Promise.all([
    db.prepare(`SELECT orders.id, orders.number, c.name AS customer_name, c.kind AS customer_kind, orders.title, orders.payment_terms,
        orders.payment_due_on, orders.version, orders.production_status, ${AGREED_TOTAL} AS agreed_cents,
        pk.ready_on, pk.notified_on, pk.picked_up_on,
        (SELECT k.status FROM check_collections k WHERE k.order_id = orders.id ORDER BY k.id DESC LIMIT 1) AS collection_status,
        (SELECT group_concat(k.status) FROM check_collections k WHERE k.order_id = orders.id AND k.status IN ('awaiting_payment','ready_for_collection')) AS open_checks
      FROM orders JOIN customers c ON c.id = orders.customer_id LEFT JOIN pickups pk ON pk.order_id = orders.id
      WHERE orders.state = 'active' AND orders.production_status = 'production_complete'
      ORDER BY orders.number`).all<OutstandingCandidate>(),
    db.prepare(`SELECT p.order_id, p.amount_cents FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.voided_at IS NULL AND o.state = 'active' AND o.production_status = 'production_complete' ORDER BY p.id`).all<{ order_id: number; amount_cents: number }>(),
  ])
  const byOrder = new Map<number, { amountCents: number }[]>()
  for (const a of amounts.results) byOrder.set(a.order_id, [...(byOrder.get(a.order_id) ?? []), { amountCents: a.amount_cents }])
  return orders.results.map((o) => ({ ...o, payments: byOrder.get(o.id) ?? [] }))
}

// ---- writes ----

type Actor = { orderId: number; actorId: number }

/** RECORD_PAYMENT_SQL at the client's version. Throws payment_request_id_exists when the request_id is taken (the route resolves it). */
export async function recordPayment(db: D1Database, p: Actor & {
  version: number; amountCents: number; method: PaymentMethod; paidOn: string; notes: string | null; requestId: string
}) {
  const { applied, data } = await m5Write(db, {
    ...p, settle: 'payment_recorded',
    data: [db.prepare(RECORD_PAYMENT_SQL).bind(p.orderId, p.amountCents, p.method, p.paidOn, p.notes, p.actorId, p.requestId, p.orderId, p.version)],
    log: { action: 'payment_recorded', after: { amount_cents: p.amountCents, method: p.method, paid_on: p.paidOn } },
  })
  const id = newId(data[0])
  return applied && id !== null ? id : null
}

/** Voids one payment (the payments_update trigger checks the owner, payments_void_log writes the audit row). */
export async function voidPayment(db: D1Database, p: Actor & { version: number; paymentId: number; reason: string }) {
  const { applied } = await m5Write(db, {
    ...p, settle: 'payment_voided',
    data: [db.prepare(`UPDATE payments SET voided_at = ${NOW}, voided_by = ?, void_reason = ? WHERE id = ? AND order_id = ? AND voided_at IS NULL AND ${GUARD}`)
      .bind(p.actorId, p.reason, p.paymentId, p.orderId, p.orderId, p.version)],
  })
  return applied
}

/** A new collection (awaiting_payment) on a pay-after-pickup, not cancelled order, re-asserted here. */
export async function createCheck(db: D1Database, p: Actor & {
  version: number; expectedCents: number; availableOn: string | null; checkNumber: string | null; notes: string | null
}) {
  const { applied, data } = await m5Write(db, {
    ...p,
    data: [db.prepare(`INSERT INTO check_collections (order_id, expected_cents, available_on, check_number, notes, created_by)
        SELECT id, ?, ?, ?, ?, ? FROM orders WHERE id = ? AND version = ? AND state <> 'cancelled' AND payment_terms = 'due_after_pickup' RETURNING id`)
      .bind(p.expectedCents, p.availableOn, p.checkNumber, p.notes, p.actorId, p.orderId, p.version)],
    log: { action: 'check_created', after: { expected_cents: p.expectedCents, available_on: p.availableOn } },
  })
  const id = newId(data[0])
  return applied && id !== null ? id : null
}

// The moves that don't create a payment, each from its one previous status (checkCheckTransition), with its date.
const MOVES = {
  ready_for_collection: { from: 'awaiting_payment', column: 'available_on', action: 'check_ready' },
  deposited: { from: 'collected', column: 'deposited_on', action: 'check_deposited' },
  cleared: { from: 'deposited', column: 'cleared_on', action: 'check_cleared' },
} as const satisfies Record<string, { from: CheckStatus; column: string; action: ActivityAction }>
export type CheckMove = keyof typeof MOVES
/** Ready, deposited or cleared. Never touches payments. Returns false when the check was no longer in the previous status. */
export async function moveCheck(db: D1Database, p: Actor & { checkId: number; to: CheckMove; on: string }) {
  const m = MOVES[p.to]
  const { applied } = await m5Write(db, {
    ...p, version: null,
    data: [db.prepare(`UPDATE check_collections SET status = ?, ${m.column} = ? WHERE id = ? AND order_id = ? AND status = ?`).bind(p.to, p.on, p.checkId, p.orderId, m.from)],
    log: { action: m.action, before: { check_id: p.checkId, check_status: m.from }, after: { check_id: p.checkId, check_status: p.to, [m.column]: p.on } },
  })
  return applied
}

/**
 * Collect: the check number (when sent) is noted first, then COLLECT_CHECK_SQL's three statements, adjacent and verbatim
 * (§4.4): status + amount, the payment, its check_collected activity row. The order bump and settle follow only when that
 * row was written, so a retry or a competing collect changes nothing at all. The caller reads the check back.
 */
export async function collectCheck(db: D1Database, p: Actor & { checkId: number; amountCents: number; checkNumber: string | null; paidOn: string }) {
  const { applied } = await m5Write(db, {
    ...p, version: null, settle: 'check_collected',
    data: [
      db.prepare(`UPDATE check_collections SET check_number = COALESCE(?, check_number) WHERE id = ? AND status IN ('awaiting_payment','ready_for_collection')`)
        .bind(p.checkNumber, p.checkId),
      db.prepare(COLLECT_CHECK_SQL[0]).bind(p.amountCents, new Date().toISOString(), p.actorId, p.checkId),
      db.prepare(COLLECT_CHECK_SQL[1]).bind(p.paidOn, p.actorId, p.checkId),
      db.prepare(COLLECT_CHECK_SQL[2]).bind(p.checkId),
    ],
  })
  return applied
}
