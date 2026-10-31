// Payments, check collections and the Payments page (M5). HTTP, auth and validation only: the rules are in
// worker/domain/payments.ts (balance, checkCheckTransition, matchRetry, …), the SQL in worker/db/payments.ts.
// Order writes carry the order's expectedVersion; the check moves are guarded by the check's own status instead, so a
// collect retried after it succeeded still answers with the stored result (PHASE2_PLAN §4.4).
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../auth'
import type {
  ApiErrorCode, Balance, CheckWriteResponse, OrderWriteResponse, OutstandingRow, PaymentsPageResponse, PaymentsResponse, RecordPaymentResponse,
} from '../../shared/api'
import { PAYMENT_METHODS, type CheckStatus } from '../../shared/enums'
import { businessToday } from '../../shared/businessDate'
import { balance, checkCheckTransition, daysOutstanding, matchRetry, nextPaymentAction, takesCheckCollection } from '../domain/payments'
import { fulfilmentStatus } from '../domain/fulfilment'
import type { DashCheck } from '../domain/dashboard'
import { getOrderByNumber, orderState, readyForPickupSince } from '../db/orders'
import * as db from '../db/payments'
import { businessDate } from './orderWrites'
import { bad, number } from './orders'

type C = Context<AppEnv>
type Order = NonNullable<Awaited<ReturnType<typeof getOrderByNumber>>>

const pathId = z.string().regex(/^[1-9]\d{0,14}$/, 'invalid id').transform(Number)
const expectedVersion = z.number().int().min(0)
const text = (max: number) => z.string().trim().min(1).max(max)
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null)
// $10,000,000: far above any order, far below JavaScript's safe integers.
const cents = z.number().int().min(1).max(1_000_000_000)

const paymentBody = z.object({
  amountCents: cents, method: z.enum(PAYMENT_METHODS), paidOn: businessDate.optional(), notes: optText(2000), requestId: text(100), expectedVersion,
})
const voidBody = z.object({ reason: text(500), expectedVersion })
const checkBody = z.object({ expectedCents: cents, availableOn: businessDate.nullish().transform((v) => v ?? null), checkNumber: optText(50), notes: optText(2000), expectedVersion })
const readyBody = z.object({ availableOn: businessDate.optional() })
const collectBody = z.object({ amountReceivedCents: cents, checkNumber: optText(50), collectedOn: businessDate.optional() })
const depositBody = z.object({ depositedOn: businessDate.optional() })
const clearBody = z.object({ clearedOn: businessDate.optional() })

export const refuse = (c: C, code: ApiErrorCode, error: string, status: 400 | 403 | 404 | 409 = 409) => c.json({ error, code }, status)
export const conflict = (c: C) => refuse(c, 'conflict_retry', 'Order changed, reload and retry')
export const notFound = (c: C, what: string) => refuse(c, 'not_found', `${what} not found`, 404)
export const today = () => businessToday(new Date())
const state = async (c: C, orderId: number) => (await orderState(c.env.DB, { id: orderId }))!

// Trigger messages from migration 0006 that restate a rule the route checks first (a race got past the read).
const DB_ERRORS: [message: string, code: ApiErrorCode, status: 403 | 409][] = [
  ['pickup_not_ready', 'pickup_not_ready', 409], ['pickup_recorded', 'pickup_recorded', 409], ['payment_required', 'payment_required', 409],
  ['release_override_invalid', 'override_requires_owner', 403], ['payment_voided', 'payment_voided', 409], ['void_requires_owner', 'void_requires_owner', 403],
  ['invalid_check_transition', 'invalid_check_transition', 409],
]
export function dbErrors(e: Error, c: C) {
  const message = e instanceof Error ? e.message : String(e)
  const hit = DB_ERRORS.find(([m]) => message.includes(m))
  if (hit) return refuse(c, hit[1], message, hit[2])
  console.error(e)
  return c.json({ error: 'Internal error' }, 500)
}

/** The order's balance from its accepted quote and non-voided payments. */
export async function loadBalance(d: D1Database, orderId: number): Promise<Balance> {
  const input = await db.balanceInput(d, orderId)
  const b = balance(input.agreedCents, input.payments)
  // The CHECKs keep every stored amount a positive integer, so this can't fail on stored rows.
  if (!b.ok) throw new Error(`order ${orderId}: ${b.error}`)
  return { agreedCents: input.agreedCents, receivedCents: b.receivedCents, outstandingCents: b.outstandingCents, creditCents: b.creditCents, status: b.status }
}

/** Parses :number and the body, loads the order (404) and refuses a stale expectedVersion before anything runs. */
export function withOrder<S extends z.ZodType>(schema: S, fn: (c: C, o: Order, body: z.infer<S>) => Promise<Response>) {
  return async (c: C) => {
    const n = number.safeParse(c.req.param('number'))
    if (!n.success) return bad(c, n.error)
    const body = schema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return bad(c, body.error)
    const o = await getOrderByNumber(c.env.DB, n.data)
    if (!o) return notFound(c, 'Order')
    if ((body.data as { expectedVersion: number }).expectedVersion !== o.version) return conflict(c)
    return fn(c, o, body.data)
  }
}
/** :checkId and the body; the check (404) with its order. */
function withCheck<S extends z.ZodType>(schema: S, fn: (c: C, k: db.CheckRow, body: z.infer<S>) => Promise<Response>) {
  return async (c: C) => {
    const id = pathId.safeParse(c.req.param('checkId'))
    if (!id.success) return bad(c, id.error)
    const body = schema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return bad(c, body.error)
    const k = await db.getCheck(c.env.DB, id.data)
    if (!k) return notFound(c, 'Check collection')
    return fn(c, k, body.data)
  }
}
const checkWritten = async (c: C, k: db.CheckRow) =>
  c.json<CheckWriteResponse>({ ...(await state(c, k.order_id)), check: db.toCheck((await db.getCheck(c.env.DB, k.id))!) })

/** The ready / deposit / clear moves: from the one previous status only, never touching payments. */
function moveRoute<S extends z.ZodType>(schema: S, to: db.CheckMove, on: (b: z.infer<S>) => string | undefined) {
  return withCheck(schema, async (c, k, b) => {
    if (!checkCheckTransition(k.status, to).ok) return refuse(c, 'invalid_check_transition', `A ${k.status} check cannot move to ${to}`)
    const applied = await db.moveCheck(c.env.DB, { orderId: k.order_id, actorId: c.get('user').id, checkId: k.id, to, on: on(b) ?? today() })
    return applied ? checkWritten(c, k) : conflict(c)
  })
}

/** The Payments page's outstanding rows (also summed on the dashboard): finished active orders that still owe money. */
export async function loadOutstanding(d: D1Database, now = today()): Promise<OutstandingRow[]> {
  const [candidates, readyAt] = await Promise.all([db.listOutstandingCandidates(d), readyForPickupSince(d)])
  const rows: OutstandingRow[] = []
  for (const o of candidates) {
    const b = balance(o.agreed_cents, o.payments)
    if (!b.ok) throw new Error(`order ${o.id}: ${b.error}`)
    if (b.status === 'paid') continue
    const at = readyAt.get(o.id)
    const readyOn = o.ready_on ?? (at === undefined ? null : businessToday(new Date(at)))
    rows.push({
      number: o.number, customerName: o.customer_name, customerKind: o.customer_kind, title: o.title, paymentTerms: o.payment_terms,
      fulfilmentStatus: fulfilmentStatus(o.production_status, { notifiedAt: o.notified_on, pickedUpAt: o.picked_up_on }), financialStatus: b.status,
      agreedCents: o.agreed_cents, receivedCents: b.receivedCents, outstandingCents: b.outstandingCents, paymentDueOn: o.payment_due_on,
      daysOutstanding: daysOutstanding({ paymentTerms: o.payment_terms, readyOn, pickedUpOn: o.picked_up_on, today: now }),
      collectionStatus: o.collection_status,
      nextAction: nextPaymentAction({ paymentTerms: o.payment_terms, pickedUp: o.picked_up_on !== null, openChecks: (o.open_checks ?? '').split(',').filter(Boolean) as CheckStatus[] }),
      version: o.version,
    })
  }
  return rows.sort((a, b) => (b.daysOutstanding ?? -1) - (a.daysOutstanding ?? -1) || a.number.localeCompare(b.number))
}
/** The ready_for_collection checks, for the dashboard's Action required. */
export async function loadChecksReady(d: D1Database): Promise<DashCheck[]> {
  return (await db.listOpenChecks(d)).filter((k) => k.status === 'ready_for_collection').map((k) => ({
    checkId: k.id, number: k.order_number, customerName: k.customer_name, title: k.order_title, dueDate: k.order_due_date,
    expectedCents: k.expected_cents, availableOn: k.available_on,
  }))
}

export function paymentRoutes() {
  return new Hono<AppEnv>()
    .onError(dbErrors)

    .get('/payments', async (c) => {
      const [outstanding, checks] = await Promise.all([loadOutstanding(c.env.DB), db.listOpenChecks(c.env.DB)])
      const of = (...s: CheckStatus[]) => checks.filter((k) => s.includes(k.status)).map((k) => ({ ...db.toCheck(k), customerName: k.customer_name }))
      return c.json<PaymentsPageResponse>({
        outstanding, checksToCollect: of('ready_for_collection'), checksAwaitingPayment: of('awaiting_payment'), checksInHand: of('collected', 'deposited'),
      })
    })

    .get('/orders/:number/payments', async (c) => {
      const n = number.safeParse(c.req.param('number'))
      if (!n.success) return bad(c, n.error)
      const o = await getOrderByNumber(c.env.DB, n.data)
      if (!o) return notFound(c, 'Order')
      const [payments, checks, bal] = await Promise.all([db.listPayments(c.env.DB, o.id), db.listOrderChecks(c.env.DB, o.id), loadBalance(c.env.DB, o.id)])
      return c.json<PaymentsResponse>({
        number: o.number, version: o.version, state: o.state, paymentTerms: o.payment_terms, paymentDueOn: o.payment_due_on,
        payments, checks: checks.map(db.toCheck), balance: bal,
      })
    })

    // A request_id seen before is resolved first, before the version check: the retry of a payment that was recorded
    // carries the version from before it, and must still get the stored payment back.
    .post('/orders/:number/payments', async (c) => {
      const n = number.safeParse(c.req.param('number'))
      if (!n.success) return bad(c, n.error)
      const parsed = paymentBody.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return bad(c, parsed.error)
      const b = parsed.data
      const o = await getOrderByNumber(c.env.DB, n.data)
      if (!o) return notFound(c, 'Order')
      const replay = async () => {
        const stored = await db.paymentByRequestId(c.env.DB, b.requestId)
        if (!stored) return null
        // An omitted paidOn meant "today" on the first submission; the retry inherits what that resolved to.
        const m = matchRetry(stored, { orderId: o.id, amountCents: b.amountCents, method: b.method, paidOn: b.paidOn ?? stored.paidOn, notes: b.notes })
        if (!m.ok) return refuse(c, 'request_id_conflict', 'This requestId was already used for a different payment')
        const { orderId: _, ...payment } = stored
        return c.json<RecordPaymentResponse>({ ...(await state(c, o.id)), payment, replayed: true }, 200)
      }
      const earlier = await replay()
      if (earlier) return earlier
      if (b.expectedVersion !== o.version) return conflict(c)
      if (o.state === 'cancelled') return refuse(c, 'order_not_active', 'Order is cancelled')
      let id: number | null
      try {
        id = await db.recordPayment(c.env.DB, {
          orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, amountCents: b.amountCents, method: b.method,
          paidOn: b.paidOn ?? today(), notes: b.notes, requestId: b.requestId,
        })
      } catch (e) {
        if (e instanceof Error && e.message.includes('payment_request_id_exists')) return (await replay()) ?? conflict(c)
        throw e
      }
      // Nothing inserted: the order moved, or a twin of this submission won the race (then it's a retry).
      if (id === null) return (await replay()) ?? conflict(c)
      return c.json<RecordPaymentResponse>({ ...(await state(c, o.id)), payment: (await db.getPayment(c.env.DB, o.id, id))!, replayed: false }, 201)
    })

    // Owner only (decision 10: corrections are audited overrides). The trigger re-checks the owner and writes the audit row.
    .post('/orders/:number/payments/:paymentId/void', withOrder(voidBody, async (c, o, b) => {
      if (c.get('user').role !== 'owner') return refuse(c, 'void_requires_owner', 'Only an owner can void a payment', 403)
      const pid = pathId.safeParse(c.req.param('paymentId'))
      if (!pid.success) return bad(c, pid.error)
      const p = await db.getPayment(c.env.DB, o.id, pid.data)
      if (!p) return notFound(c, 'Payment')
      if (p.voided) return refuse(c, 'payment_voided', 'This payment is already voided')
      const applied = await db.voidPayment(c.env.DB, { orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, paymentId: p.id, reason: b.reason })
      return applied ? c.json<OrderWriteResponse>(await state(c, o.id)) : conflict(c)
    }))

    .post('/orders/:number/checks', withOrder(checkBody, async (c, o, b) => {
      if (o.state === 'cancelled') return refuse(c, 'order_not_active', 'Order is cancelled')
      if (!takesCheckCollection(o.payment_terms)) return refuse(c, 'check_not_allowed', 'Only orders paid after pickup take a check collection')
      const id = await db.createCheck(c.env.DB, {
        orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, expectedCents: b.expectedCents, availableOn: b.availableOn, checkNumber: b.checkNumber, notes: b.notes,
      })
      if (id === null) return conflict(c)
      return c.json<CheckWriteResponse>({ ...(await state(c, o.id)), check: db.toCheck((await db.getCheck(c.env.DB, id))!) }, 201)
    }))

    .post('/checks/:checkId/ready', moveRoute(readyBody, 'ready_for_collection', (b) => b.availableOn))
    .post('/checks/:checkId/deposit', moveRoute(depositBody, 'deposited', (b) => b.depositedOn))
    .post('/checks/:checkId/clear', moveRoute(clearBody, 'cleared', (b) => b.clearedOn))

    // Collect = COLLECT_CHECK_SQL (one payment, one activity row, however many times it runs). Already collected — by
    // this request's earlier attempt or anyone else's — answers from the stored row: the same amount (and check number,
    // when sent) is 200 with nothing written; anything else is 409 check_collect_conflict, also after reading back a lost race.
    .post('/checks/:checkId/collect', withCheck(collectBody, async (c, k, b) => {
      const same = (r: db.CheckRow) => r.amount_received_cents === b.amountReceivedCents && (b.checkNumber === null || r.check_number === b.checkNumber)
      const answer = async (r: db.CheckRow) => (same(r) ? checkWritten(c, r) : refuse(c, 'check_collect_conflict', 'This check was already collected with a different amount'))
      if (['collected', 'deposited', 'cleared'].includes(k.status)) return answer(k)
      if (!checkCheckTransition(k.status, 'collected').ok) return refuse(c, 'invalid_check_transition', `A ${k.status} check cannot be collected`)
      await db.collectCheck(c.env.DB, {
        orderId: k.order_id, actorId: c.get('user').id, checkId: k.id, amountCents: b.amountReceivedCents, checkNumber: b.checkNumber, paidOn: b.collectedOn ?? today(),
      })
      return answer((await db.getCheck(c.env.DB, k.id))!)
    }))
}
