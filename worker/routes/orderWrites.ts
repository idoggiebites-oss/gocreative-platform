// The order, quote and direct-authorization writes (M1c). HTTP, auth and validation only: the rules are in
// worker/domain, the SQL (one batch per write, with its activity row and the re-derive) in worker/db/orders.ts.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../auth'
import type { ApiErrorCode, OrderWriteResponse } from '../../shared/api'
import { AUTHORIZATION_METHODS, ITEM_KINDS, METHODS, ORDER_SOURCES, PAYMENT_TERMS } from '../../shared/enums'
import type { ProductionStatus } from '../../shared/enums'
import { addDays, businessToday } from '../../shared/businessDate'
import { formatOrderNumber } from '../domain/orderNumber'
import { checkQuoteAcceptable, checkQuoteTransition, itemsChangeRequiresReapproval, planNewVersion, restoreLines, snapshot, validateItem } from '../domain/quotes'
import { readiness } from '../domain/readiness'
import * as db from '../db/orders'
import { bad, number } from './orders'

type C = Context<AppEnv>
type Order = NonNullable<Awaited<ReturnType<typeof db.getOrderByNumber>>>

const id = z.number().int().positive()
const text = (max: number) => z.string().trim().min(1).max(max)
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null)
export const businessDate = z.string().refine((s) => {
  try {
    return addDays(s, 0) === s
  } catch {
    return false
  }
}, 'must be a YYYY-MM-DD date')
const expectedVersion = z.number().int().min(0)

const item = z.object({
  id: id.optional(),
  kind: z.enum(ITEM_KINDS),
  description: optText(500),
  product: optText(200),
  garmentColor: optText(100),
  method: z.enum(METHODS).nullish().transform((v) => v ?? null),
  sizes: z.record(z.string().trim().min(1).max(20), z.number().int().min(0)).nullish().transform((v) => (v && Object.keys(v).length ? v : null)),
  quantity: z.number().int(),
  unitPriceCents: z.number().int(),
  notes: optText(2000),
}).superRefine((i, ctx) => {
  if (i.kind === 'product' && (!i.product || !i.method)) ctx.addIssue({ code: 'custom', message: 'a product line needs product and method' })
  const valid = validateItem(i)
  if (!valid.ok) ctx.addIssue({ code: 'custom', message: valid.error })
})
const items = z.array(item).max(200)
// Every guarded write requires the version the client acted on; the server's own read is never substituted for it.
const reason = z.object({ reason: text(500), expectedVersion })
const versioned = z.object({ expectedVersion })

const STARTED: readonly ProductionStatus[] = ['in_production', 'quality_control', 'production_complete']
// Trigger messages from migration 0002 that are the database restating a rule the route checks first.
const DB_ERROR_CODES = ['quote_frozen', 'quote_not_draft', 'invalid_quote_transition', 'no_product_line'] as const

const refuse = (c: C, code: ApiErrorCode, error: string, status: 400 | 404 | 409 = 409) => c.json({ error, code }, status)
const conflict = (c: C) => refuse(c, 'conflict_retry', 'Order changed, reload and retry')
const written = (c: C, state: db.OrderStateRow | null, extra: Partial<OrderWriteResponse> = {}) =>
  state ? c.json<OrderWriteResponse>({ ...state, ...extra }) : conflict(c)
const today = () => businessToday(new Date())
const year = () => Number(today().slice(0, 4))

/** Parses :number and the body, loads the order (404), and refuses a stale expectedVersion before anything runs. */
function withOrder<S extends z.ZodType>(schema: S, fn: (c: C, o: Order, body: z.infer<S>) => Promise<Response>) {
  return async (c: C) => {
    const n = number.safeParse(c.req.param('number'))
    if (!n.success) return bad(c, n.error)
    const body = schema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return bad(c, body.error)
    const o = await db.getOrderByNumber(c.env.DB, n.data)
    if (!o) return refuse(c, 'not_found', 'Order not found', 404)
    // A client that read an older version is refused before anything runs; the batch re-checks the version the
    // client sent (body.expectedVersion, never o.version) either way.
    const sent = (body.data as { expectedVersion?: number }).expectedVersion
    if (sent !== undefined && sent !== o.version) return conflict(c)
    return fn(c, o, body.data)
  }
}
/** Why a contact-guarded write changed nothing: the contact was archived meanwhile, or the order moved on. */
async function contactRefusal(c: C, contactId: number | null) {
  const contact = contactId === null ? null : await db.getContactCustomer(c.env.DB, contactId)
  return contact?.archived ? refuse(c, 'contact_archived', 'Contact is archived') : conflict(c)
}
const notActive = (c: C) => refuse(c, 'order_not_active', 'Order is cancelled or closed')
const started = (c: C) => refuse(c, 'production_started', 'Production has started; items and quotes are frozen')

/** The production status a brand-new order starts in: whatever readiness derives with nothing done yet. */
const initialStatus = (artworkRequired: boolean, poRequired: boolean) => readiness({
  state: 'active', quote: null, itemsRevision: 0, artworkRequired, designs: [], poRequired, latestPo: null, authorizedAt: null,
  materialsRequired: true, purchases: [], prepStatus: 'not_started',
}).preProductionStatus

const toWrite = (i: z.infer<typeof item>): db.ItemWrite => ({
  id: i.id, kind: i.kind, description: i.description, product: i.product, garmentColor: i.garmentColor, method: i.method,
  sizes: i.sizes, quantity: i.quantity, unitPriceCents: i.unitPriceCents, notes: i.notes,
})
const snapshotOr409 = <T extends db.ItemWrite>(c: C, from: T[]) => {
  const snap = snapshot(from)
  if (snap.ok) return snap
  return refuse(c, snap.error === 'discount_exceeds_total' ? 'discount_exceeds_total' : 'invalid_request', `Quote refused: ${snap.error}`)
}
const quoteLines = (lines: (db.ItemWrite & { lineTotalCents: number })[]): db.QuoteLineWrite[] =>
  lines.map(({ id: _id, notes: _notes, ...line }) => line)

export function orderWriteRoutes() {
  return new Hono<AppEnv>()
    .onError((e, c) => {
      const message = e instanceof Error ? e.message : String(e)
      const code = DB_ERROR_CODES.find((k) => message.includes(k))
      if (code) return refuse(c, code, message)
      // Two writers raced for the same quote version (or the one accepted quote): the loser retries.
      if (/UNIQUE constraint failed: quotes\./.test(message)) return conflict(c)
      console.error(e)
      return c.json({ error: 'Internal error' }, 500)
    })

    .post('/orders', async (c) => {
      const body = z.object({
        customerId: id, contactId: id.nullish(), source: z.enum(ORDER_SOURCES), title: text(200), dueDate: businessDate.nullish(),
        poRequired: z.boolean().optional(), paymentTerms: z.enum(PAYMENT_TERMS).optional(), artworkRequired: z.boolean().default(true),
        items: items.default([]),
      }).safeParse(await c.req.json().catch(() => null))
      if (!body.success) return bad(c, body.error)
      const b = body.data
      const customer = await db.getCustomerDefaults(c.env.DB, b.customerId)
      if (!customer) return refuse(c, 'not_found', 'Customer not found', 404)
      if (b.contactId) {
        const contact = await db.getContactCustomer(c.env.DB, b.contactId)
        if (contact?.customer_id !== b.customerId) return refuse(c, 'contact_not_for_customer', 'Contact does not belong to this customer', 400)
        if (contact.archived) return refuse(c, 'contact_archived', 'Contact is archived', 409)
      }
      const poRequired = b.poRequired ?? customer.default_po_required === 1
      const y = year()
      const n = await db.createOrder(c.env.DB, {
        year: y, actorId: c.get('user').id, customerId: b.customerId, contactId: b.contactId ?? null, source: b.source, title: b.title,
        dueDate: b.dueDate ?? null, poRequired, paymentTerms: b.paymentTerms ?? customer.default_payment_terms, artworkRequired: b.artworkRequired,
        productionStatus: initialStatus(b.artworkRequired, poRequired), items: b.items.map((i) => ({ ...toWrite(i), id: undefined })),
      })
      if (n === null) return contactRefusal(c, b.contactId ?? null) // nothing written, no number used
      const state = await db.orderState(c.env.DB, { number: formatOrderNumber(y, n) })
      return state ? c.json<OrderWriteResponse>(state, 201) : conflict(c)
    })

    .patch('/orders/:number', withOrder(z.object({
      expectedVersion, title: text(200).optional(), dueDate: businessDate.nullable().optional(), contactId: id.nullable().optional(),
      source: z.enum(ORDER_SOURCES).optional(), poRequired: z.boolean().optional(), paymentTerms: z.enum(PAYMENT_TERMS).optional(),
      artworkRequired: z.boolean().optional(), materialsRequired: z.boolean().optional(), confirmNoPurchasing: z.boolean().optional(),
      assigneeId: id.nullable().optional(),
    }), async (c, o, b) => {
      if (o.state !== 'active') return notActive(c)
      const current: Record<db.HeaderField, string | number | null> = {
        title: o.title, dueDate: o.due_date, contactId: o.contact_id, source: o.source, poRequired: o.po_required, paymentTerms: o.payment_terms,
        artworkRequired: o.artwork_required, materialsRequired: o.materials_required, assigneeId: o.assignee_id,
      }
      const changes: db.HeaderChange = {}
      for (const key of Object.keys(current) as db.HeaderField[]) {
        const v = b[key]
        if (v === undefined) continue
        const value = typeof v === 'boolean' ? (v ? 1 : 0) : v
        if (value !== current[key]) changes[key] = value
      }
      const noPurchasing = changes.materialsRequired === 0
      if (noPurchasing && b.confirmNoPurchasing !== true) return refuse(c, 'confirmation_required', 'No purchasing needed must be confirmed', 400)
      if (changes.contactId) {
        const contact = await db.getContactCustomer(c.env.DB, changes.contactId as number)
        if (contact?.customer_id !== o.customer_id) return refuse(c, 'contact_not_for_customer', 'Contact does not belong to this customer', 400)
        if (contact.archived) return refuse(c, 'contact_archived', 'Contact is archived', 409)
      }
      if (changes.assigneeId && !(await db.isActiveUser(c.env.DB, changes.assigneeId as number))) {
        return refuse(c, 'invalid_request', 'Assignee must be an active user', 400)
      }
      if (!Object.keys(changes).length) return written(c, await db.orderState(c.env.DB, { id: o.id }))
      const state = await db.updateOrderHeader(c.env.DB, { orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, changes, before: current, noPurchasing })
      if (!state && changes.contactId) return contactRefusal(c, changes.contactId as number)
      return written(c, state)
    }))

    .put('/orders/:number/items', withOrder(z.object({ expectedVersion, items }), async (c, o, b) => {
      if (o.state !== 'active') return notActive(c)
      if (STARTED.includes(o.production_status)) return started(c)
      const before = await db.listItems(c.env.DB, o.id)
      const ids = b.items.flatMap((i) => (i.id === undefined ? [] : [i.id]))
      if (new Set(ids).size !== ids.length || ids.some((i) => !before.some((x) => x.id === i))) {
        return refuse(c, 'invalid_request', 'Item ids must be unique and belong to this order', 400)
      }
      const after = b.items.map(toWrite)
      const bump = itemsChangeRequiresReapproval(before, after) ? 1 : 0
      return written(c, await db.replaceItems(c.env.DB, {
        orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, items: after, itemsRevision: { from: o.items_revision, to: o.items_revision + bump },
      }))
    }))

    .post('/orders/:number/quotes', withOrder(versioned, async (c, o, b) => {
      if (o.state !== 'active') return notActive(c)
      if (STARTED.includes(o.production_status)) return started(c)
      const snap = snapshotOr409(c, await db.listItems(c.env.DB, o.id))
      if (snap instanceof Response) return snap
      const plan = planNewVersion(await db.listQuotes(c.env.DB, o.id))
      const state = await db.createQuote(c.env.DB, {
        orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, quoteVersion: plan.version, itemsRevision: o.items_revision,
        totals: snap.totals, lines: quoteLines(snap.lines), supersedeIds: plan.supersedeIds.map(Number),
      })
      return written(c, state, { quote: { version: plan.version, status: 'draft' } })
    }))

    .post('/orders/:number/quotes/:version/refresh', withOrder(versioned, async (c, o, b) => {
      if (o.state !== 'active') return notActive(c)
      if (STARTED.includes(o.production_status)) return started(c)
      const q = (await db.listQuotes(c.env.DB, o.id)).find((x) => String(x.version) === c.req.param('version'))
      if (!q) return refuse(c, 'not_found', 'Quote not found', 404)
      if (q.status !== 'draft') return refuse(c, 'quote_not_draft', 'Only a draft quote can be refreshed')
      const snap = snapshotOr409(c, await db.listItems(c.env.DB, o.id))
      if (snap instanceof Response) return snap
      return written(c, await db.refreshQuote(c.env.DB, {
        orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, quoteId: q.id, quoteVersion: q.version, itemsRevision: o.items_revision,
        totals: snap.totals, lines: quoteLines(snap.lines),
      }), { quote: { version: q.version, status: 'draft' } })
    }))

    .post('/orders/:number/quotes/:version/duplicate', withOrder(versioned, async (c, o, b) => {
      if (o.state !== 'active') return notActive(c)
      if (STARTED.includes(o.production_status)) return started(c)
      const quotes = await db.listQuotes(c.env.DB, o.id)
      const source = quotes.find((x) => String(x.version) === c.req.param('version'))
      if (!source) return refuse(c, 'not_found', 'Quote not found', 404)
      const current = await db.listItems(c.env.DB, o.id)
      // The quote's lines become the order's items again (internal notes don't travel with a quote).
      const restored = restoreLines(current, (await db.quoteLines(c.env.DB, source.id)).map((l) => ({ ...l, notes: null })))
        .map((l) => ({ ...l, id: l.id as number | undefined }))
      const itemsRevision = o.items_revision + (itemsChangeRequiresReapproval(current, restored) ? 1 : 0)
      const snap = snapshotOr409(c, restored)
      if (snap instanceof Response) return snap
      const plan = planNewVersion(quotes)
      return written(c, await db.createQuote(c.env.DB, {
        orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, quoteVersion: plan.version, itemsRevision, totals: snap.totals,
        lines: quoteLines(snap.lines), supersedeIds: plan.supersedeIds.map(Number), replaceItems: restored, duplicateOf: source.version,
      }), { quote: { version: plan.version, status: 'draft' } })
    }))

    .patch('/orders/:number/quotes/:version', withOrder(z.object({ to: z.enum(['sent', 'accepted', 'declined']), expectedVersion }), async (c, o, b) => {
      if (o.state !== 'active') return notActive(c)
      const q = (await db.listQuotes(c.env.DB, o.id)).find((x) => String(x.version) === c.req.param('version'))
      if (!q) return refuse(c, 'not_found', 'Quote not found', 404)
      const check = checkQuoteTransition(q.status, b.to)
      if (!check.ok) return refuse(c, 'invalid_quote_transition', `Quote ${q.status} cannot become ${b.to}`)
      if (b.to === 'accepted') {
        // Always through checkQuoteAcceptable: a charge-only or empty snapshot is never accepted (M0 review).
        const acceptable = checkQuoteAcceptable(await db.quoteLines(c.env.DB, q.id))
        if (!acceptable.ok) {
          const code = (['no_product_line', 'discount_exceeds_total'] as const).find((k) => k === acceptable.error) ?? 'invalid_request'
          return refuse(c, code, `Quote cannot be accepted: ${acceptable.error}`)
        }
        if (q.items_revision !== o.items_revision) return refuse(c, 'quote_stale', 'The items changed after this quote was made')
      }
      return written(c, await db.changeQuoteStatus(c.env.DB, { orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, quoteId: q.id, quoteVersion: q.version, from: q.status, to: b.to }),
        { quote: { version: q.version, status: b.to } })
    }))

    .post('/orders/:number/repeat', withOrder(z.object({ source: z.enum(ORDER_SOURCES), dueDate: businessDate.nullish() }), async (c, o, b) => {
      // The contact is copied, so it must still be the customer's live contact (the SQL re-checks it).
      if (o.contact_id !== null) {
        const contact = await db.getContactCustomer(c.env.DB, o.contact_id)
        if (contact?.customer_id !== o.customer_id) return refuse(c, 'contact_not_for_customer', "The source order's contact is not this customer's")
        if (contact.archived) return refuse(c, 'contact_archived', "The source order's contact is archived")
      }
      const y = year()
      const n = await db.repeatOrder(c.env.DB, {
        year: y, actorId: c.get('user').id, sourceId: o.id, source: b.source, dueDate: b.dueDate ?? null,
        productionStatus: initialStatus(o.artwork_required === 1, o.po_required === 1),
      })
      if (n === null) return contactRefusal(c, o.contact_id) // nothing written, no number used
      const state = await db.orderState(c.env.DB, { number: formatOrderNumber(y, n) })
      return state ? c.json<OrderWriteResponse>(state, 201) : conflict(c)
    }))

    .post('/orders/:number/authorization', withOrder(z.object({ method: z.enum(AUTHORIZATION_METHODS), notes: optText(2000), expectedVersion }), async (c, o, b) => {
      if (o.state !== 'active') return notActive(c)
      // Direct authorization never substitutes for a required PO.
      if (o.po_required === 1) return refuse(c, 'po_required', 'This order needs a purchase order')
      return written(c, await db.recordAuthorization(c.env.DB, { orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, method: b.method, notes: b.notes, previous: o.authorization_method }))
    }))

    .delete('/orders/:number/authorization', withOrder(reason, async (c, o, b) => {
      if (o.state !== 'active') return notActive(c)
      if (!o.authorized_at) return refuse(c, 'not_authorized', 'This order has no direct authorization')
      return written(c, await db.revokeAuthorization(c.env.DB, { orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, reason: b.reason, previous: o.authorization_method }))
    }))

    .post('/orders/:number/cancel', withOrder(reason, async (c, o, b) => {
      if (o.state !== 'active') return refuse(c, 'transition_not_allowed', 'Only an active order can be cancelled')
      const productionTo = o.production_status === 'in_production'
        ? readiness(await db.readinessInput(c.env.DB, o)).preProductionStatus : o.production_status
      return written(c, await db.cancelOrder(c.env.DB, { orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id, reason: b.reason, productionFrom: o.production_status, productionTo }))
    }))

    .post('/orders/:number/reopen', withOrder(versioned, async (c, o, b) => {
      if (o.state !== 'cancelled') return refuse(c, 'transition_not_allowed', 'Only a cancelled order can be reopened')
      return written(c, await db.reopenOrder(c.env.DB, { orderId: o.id, version: b.expectedVersion, actorId: c.get('user').id }))
    }))

    .post('/orders/:number/notes', withOrder(z.object({ body: text(5000) }), async (c, o, b) => {
      await db.addNote(c.env.DB, { orderId: o.id, actorId: c.get('user').id, body: b.body })
      return c.json({ number: o.number }, 201)
    }))
}
