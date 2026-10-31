import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Hono } from 'hono'
import { appRoutes } from '../../worker/routes/app'
import type { AppEnv } from '../../worker/auth'
import { ACTIVITY_ACTIONS, type DashboardResponse, type OrderDetailResponse, type OrderWriteResponse } from '../../shared/api'
import { formatOrderNumber } from '../../worker/domain/orderNumber'
import * as dbo from '../../worker/db/orders'
import { createTestD1 } from './d1'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
const MINIMAL = `INSERT INTO users (id, email, name, role) VALUES (1, 'owner1@example.com', 'Owner One', 'owner');
  INSERT INTO customers (id, kind, name, default_po_required, default_payment_terms) VALUES (1, 'district', 'D', 1, 'due_after_pickup');`

function setup(withSeed = true) {
  const { db, sqlite } = createTestD1()
  sqlite.exec(withSeed ? seed : MINIMAL)
  const app = new Hono<AppEnv>().route('/api/app', appRoutes())
  const call = (method: string, path: string, body?: unknown, auth = true, DB = db) =>
    app.request(
      `http://localhost/api/app${path}`,
      { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
      auth ? { DB, DEV_AUTH_EMAIL: 'owner1@example.com' } : { DB, ACCESS_AUD: 'a', ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com' },
    )
  const one = <T>(sql: string, ...p: (string | number)[]) => sqlite.prepare(sql).get(...p) as T
  const all = <T>(sql: string, ...p: (string | number)[]) => sqlite.prepare(sql).all(...p) as T[]
  const order = (n: string) => one<{ id: number; version: number; production_status: string; state: string; items_revision: number; [k: string]: unknown }>('SELECT * FROM orders WHERE number = ?', n)
  const activityCount = () => one<{ n: number }>('SELECT COUNT(*) AS n FROM activity_log').n
  const lastActivity = () => one<{ action: string; entity_id: number; before: string | null; after: string | null }>('SELECT action, entity_id, before, after FROM activity_log ORDER BY id DESC LIMIT 1')
  const send = async <T = OrderWriteResponse>(method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body)
    return { status: res.status, body: (await res.json()) as T & { code?: string } }
  }
  /** A write that must be refused: right status and code, and nothing logged. */
  const refused = async (method: string, path: string, body: unknown, status: number, code: string) => {
    const before = activityCount()
    const res = await send(method, path, body)
    expect(res, `${method} ${path}`).toMatchObject({ status, body: { code } })
    expect(activityCount(), `${method} ${path} logged`).toBe(before)
  }
  const v = (n: string) => order(n).version
  return { db, sqlite, call, one, all, order, activityCount, lastActivity, send, refused, v }
}
type T = ReturnType<typeof setup>

const tee = { kind: 'product', product: 'Gildan tee', method: 'screen', garmentColor: 'Black', sizes: { M: 6, L: 4 }, quantity: 10, unitPriceCents: 1200 }
const itemsOf = (t: T, n: string) => t.all<{ id: number; kind: string; product: string | null; quantity: number; unit_price_cents: number; notes: string | null; sizes: string | null }>(
  'SELECT id, kind, product, quantity, unit_price_cents, notes, sizes FROM order_items WHERE order_id = (SELECT id FROM orders WHERE number = ?) ORDER BY id', n)
const quotesOf = (t: T, n: string) => t.all<{ version: number; status: string; items_revision: number; total_cents: number; sent_at: string | null; decided_at: string | null }>(
  'SELECT version, status, items_revision, total_cents, sent_at, decided_at FROM quotes WHERE order_id = (SELECT id FROM orders WHERE number = ?) ORDER BY version', n)

afterEach(() => vi.useRealTimers())

describe('auth', () => {
  test('401 without auth on every write endpoint', async () => {
    const t = setup()
    for (const [method, path] of [
      ['POST', '/orders'], ['PATCH', '/orders/2026-0022'], ['PUT', '/orders/2026-0022/items'], ['POST', '/orders/2026-0022/quotes'],
      ['POST', '/orders/2026-0023/quotes/2/refresh'], ['POST', '/orders/2026-0023/quotes/1/duplicate'], ['PATCH', '/orders/2026-0022/quotes/1'],
      ['POST', '/orders/2026-0022/repeat'], ['POST', '/orders/2026-0021/authorization'], ['DELETE', '/orders/2026-0017/authorization'],
      ['POST', '/orders/2026-0022/cancel'], ['POST', '/orders/2026-0024/reopen'], ['POST', '/orders/2026-0022/notes'],
    ]) {
      const before = t.activityCount()
      expect((await t.call(method!, path!, {}, false)).status, `${method} ${path}`).toBe(401)
      expect(t.activityCount()).toBe(before)
    }
  })
})

describe('create order', () => {
  test('defaults come from the customer, the status from readiness, and the number from the counter', async () => {
    const t = setup()
    const year = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' }).format(new Date()))
    t.sqlite.exec(`INSERT OR REPLACE INTO counters (name, year, next) VALUES ('order', ${year}, 26)`)
    const district = await t.send('POST', '/orders', { customerId: 1, contactId: 2, source: 'email', title: 'Band hoodies', dueDate: '2026-12-01', items: [tee] })
    expect(district).toMatchObject({ status: 201, body: { number: formatOrderNumber(year, 26), productionStatus: 'awaiting_quote', itemsRevision: 0, state: 'active', version: 0 } })
    expect(t.order(district.body.number)).toMatchObject({ customer_id: 1, contact_id: 2, po_required: 1, payment_terms: 'due_after_pickup', artwork_required: 1, due_date: '2026-12-01', created_by: 1 })
    expect(itemsOf(t, district.body.number)).toMatchObject([{ kind: 'product', product: 'Gildan tee', quantity: 10, unit_price_cents: 1200, sizes: '{"M":6,"L":4}' }])
    expect(t.lastActivity()).toMatchObject({ action: 'created', entity_id: t.order(district.body.number).id })
    // An individual: no PO, pays at pickup; explicit values override the defaults.
    const person = await t.send('POST', '/orders', { customerId: 6, source: 'phone', title: 'Tees', artworkRequired: false })
    expect(person.body.number).toBe(formatOrderNumber(year, 27))
    expect(t.order(person.body.number)).toMatchObject({ po_required: 0, payment_terms: 'due_at_pickup', artwork_required: 0, contact_id: null })
    const override = await t.send('POST', '/orders', { customerId: 6, source: 'phone', title: 'Tees', poRequired: true, paymentTerms: 'due_after_pickup' })
    expect(t.order(override.body.number)).toMatchObject({ po_required: 1, payment_terms: 'due_after_pickup' })
  })
  test("a contact must belong to the order's customer", async () => {
    const t = setup()
    const orders = t.one<{ n: number }>('SELECT COUNT(*) AS n FROM orders').n
    await t.refused('POST', '/orders', { customerId: 1, contactId: 3, source: 'phone', title: 'x' }, 400, 'contact_not_for_customer') // contact 3 is Cedar Hollow's
    await t.refused('POST', '/orders', { customerId: 1, contactId: 999, source: 'phone', title: 'x' }, 400, 'contact_not_for_customer')
    await t.refused('POST', '/orders', { customerId: 999, source: 'phone', title: 'x' }, 404, 'not_found')
    expect(t.one<{ n: number }>('SELECT COUNT(*) AS n FROM orders').n).toBe(orders)
    // The SQL re-checks it too: a contact that doesn't match never lands, and nothing is logged.
    const before = t.activityCount()
    await dbo.createOrder(t.db, { year: 2026, actorId: 1, customerId: 1, contactId: 3, source: 'phone', title: 'x', dueDate: null, poRequired: true,
      paymentTerms: 'due_after_pickup', artworkRequired: true, productionStatus: 'awaiting_quote', items: [] })
    expect(t.one<{ n: number }>('SELECT COUNT(*) AS n FROM orders').n).toBe(orders)
    expect(t.activityCount()).toBe(before)
  })
  test('invalid input is 400: bad date, sizes that do not sum, a product line without a method, cents that are not integers', async () => {
    const t = setup()
    const base = { customerId: 6, source: 'phone', title: 'x' }
    await t.refused('POST', '/orders', { ...base, dueDate: '2026-02-30' }, 400, 'invalid_request')
    await t.refused('POST', '/orders', { ...base, items: [{ ...tee, sizes: { M: 1 } }] }, 400, 'invalid_request')
    await t.refused('POST', '/orders', { ...base, items: [{ ...tee, method: null }] }, 400, 'invalid_request')
    await t.refused('POST', '/orders', { ...base, items: [{ ...tee, unitPriceCents: 12.5 }] }, 400, 'invalid_request')
  })
  test('the counter row is created on first use, numbers run in sequence, and the year is the shop-time year', async () => {
    const t = setup(false)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2027-01-01T04:30:00Z')) // still Dec 31, 2026 in Chicago
    expect(t.one<{ n: number }>('SELECT COUNT(*) AS n FROM counters').n).toBe(0)
    const a = await t.send('POST', '/orders', { customerId: 1, source: 'phone', title: 'a' })
    const b = await t.send('POST', '/orders', { customerId: 1, source: 'phone', title: 'b' })
    expect([a.body.number, b.body.number]).toEqual(['2026-0001', '2026-0002'])
    vi.setSystemTime(new Date('2027-01-01T06:30:00Z')) // Jan 1 in Chicago: a new year's counter
    expect((await t.send('POST', '/orders', { customerId: 1, source: 'phone', title: 'c' })).body.number).toBe('2027-0001')
    expect(t.all('SELECT year, next FROM counters ORDER BY year')).toEqual([{ year: 2026, next: 3 }, { year: 2027, next: 2 }])
    // The SQL formatting agrees with formatOrderNumber past four digits.
    t.sqlite.exec(`UPDATE counters SET next = 10000 WHERE year = 2027`)
    expect((await t.send('POST', '/orders', { customerId: 1, source: 'phone', title: 'd' })).body.number).toBe(formatOrderNumber(2027, 10000))
  })
})

describe('edit order header', () => {
  test('changes the fields, bumps the version, logs once', async () => {
    const t = setup()
    const before = t.activityCount()
    const res = await t.send('PATCH', '/orders/2026-0022', { expectedVersion: 0, title: 'Memorial plaque (bronze)', dueDate: null, contactId: null, assigneeId: 2, source: 'email' })
    expect(res).toMatchObject({ status: 200, body: { number: '2026-0022', version: 1, productionStatus: 'awaiting_quote' } })
    expect(t.order('2026-0022')).toMatchObject({ title: 'Memorial plaque (bronze)', due_date: null, assignee_id: 2, source: 'email' })
    expect(t.activityCount()).toBe(before + 1)
    expect(t.lastActivity()).toMatchObject({ action: 'order_updated' })
    // The detail shows version (the guard) and only allowlisted activity keys.
    const d = (await (await t.call('GET', '/orders/2026-0022')).json()) as OrderDetailResponse
    expect(d.order.version).toBe(1)
    expect(d.activity[0]?.after).toMatchObject({ title: 'Memorial plaque (bronze)', fields: ['title', 'due_date', 'source', 'assignee_id'] })
  })
  test('a stale expectedVersion is 409 conflict_retry and changes nothing', async () => {
    const t = setup()
    await t.send('PATCH', '/orders/2026-0022', { expectedVersion: 0, title: 'first' })
    await t.refused('PATCH', '/orders/2026-0022', { expectedVersion: 0, title: 'second' }, 409, 'conflict_retry')
    expect(t.order('2026-0022').title).toBe('first')
  })
  test('the version guard holds in the SQL: a write between the read and the batch wins, the stale one changes and logs nothing', async () => {
    const t = setup()
    const o = t.order('2026-0022')
    t.sqlite.exec(`UPDATE orders SET title = 'intervening', version = version + 1 WHERE id = ${o.id}`)
    const before = t.activityCount()
    expect(await dbo.updateOrderHeader(t.db, { orderId: o.id, version: o.version, actorId: 1, changes: { title: 'stale' }, before: { title: o.title as string }, noPurchasing: false })).toBeNull()
    expect(await dbo.replaceItems(t.db, { orderId: o.id, version: o.version, actorId: 1, items: [], itemsRevision: { from: 1, to: 2 } })).toBeNull()
    expect(await dbo.recordAuthorization(t.db, { orderId: o.id, version: o.version, actorId: 1, method: 'phone', notes: null, previous: null })).toBeNull()
    expect(t.order('2026-0022')).toMatchObject({ title: 'intervening', items_revision: 1, authorized_at: null })
    expect(itemsOf(t, '2026-0022')).toHaveLength(2)
    expect(t.activityCount()).toBe(before)
  })
  test('"No purchasing needed" needs confirmation, is logged distinctly, and re-derives the status', async () => {
    const t = setup()
    // Order 16: authorized, artwork approved, waiting only on materials and prep.
    await t.refused('PATCH', '/orders/2026-0016', { expectedVersion: 0, materialsRequired: false }, 400, 'confirmation_required')
    const res = await t.send('PATCH', '/orders/2026-0016', { expectedVersion: 0, materialsRequired: false, confirmNoPurchasing: true })
    expect(res.body.productionStatus).toBe('awaiting_preparation')
    const rows = t.all<{ action: string; after: string }>(`SELECT action, after FROM activity_log WHERE entity_id = 16 ORDER BY id DESC LIMIT 2`)
    expect(rows.map((r) => r.action)).toEqual(['production_status_changed', 'no_purchasing_confirmed'])
    expect(JSON.parse(rows[0]!.after)).toEqual({ production_status: 'awaiting_preparation', reason: 'no_purchasing_confirmed' })
  })
  test('an archived contact cannot be put on an order, on create or edit', async () => {
    const t = setup()
    t.sqlite.exec(`UPDATE customer_contacts SET archived_at = '2026-10-01T00:00:00Z' WHERE id = 2`) // customer 1's
    await t.refused('POST', '/orders', { customerId: 1, contactId: 2, source: 'phone', title: 'x' }, 409, 'contact_archived')
    await t.refused('PATCH', '/orders/2026-0007', { expectedVersion: 0, contactId: 2 }, 409, 'contact_archived')
  })
  test('contact from another customer, an inactive assignee, a cancelled order: refused, nothing logged', async () => {
    const t = setup()
    t.sqlite.exec(`INSERT INTO users (id, email, name, role, active) VALUES (3, 'gone@example.com', 'Gone', 'staff', 0)`)
    await t.refused('PATCH', '/orders/2026-0007', { expectedVersion: 0, contactId: 3 }, 400, 'contact_not_for_customer')
    await t.refused('PATCH', '/orders/2026-0007', { expectedVersion: 0, assigneeId: 3 }, 400, 'invalid_request')
    await t.refused('PATCH', '/orders/2026-0024', { expectedVersion: 0, title: 'x' }, 409, 'order_not_active')
    await t.refused('PATCH', '/orders/2026-9999', { expectedVersion: 0, title: 'x' }, 404, 'not_found')
    expect((await t.send('PATCH', '/orders/2026-0007', { expectedVersion: 0, contactId: 2 })).status).toBe(200) // same customer
  })
})

describe('replace items', () => {
  const asInput = (t: T, n: string) => itemsOf(t, n).map((i) => {
    const full = t.one<Record<string, unknown>>('SELECT * FROM order_items WHERE id = ?', i.id)
    return { id: i.id, kind: full.kind, description: full.description, product: full.product, garmentColor: full.garment_color, method: full.method,
      sizes: full.sizes ? JSON.parse(full.sizes as string) : null, quantity: full.quantity, unitPriceCents: full.unit_price_cents, notes: full.notes }
  })
  test('internal notes never bump items_revision; a customer-facing change does, once', async () => {
    const t = setup()
    const items = asInput(t, '2026-0022')
    const notes = await t.send('PUT', '/orders/2026-0022/items', { expectedVersion: 0, items: items.map((i) => ({ ...i, notes: 'blank stock from JDS' })) })
    expect(notes.body).toMatchObject({ itemsRevision: 1, version: 1 })
    expect(itemsOf(t, '2026-0022').map((i) => i.notes)).toEqual(['blank stock from JDS', 'blank stock from JDS'])
    expect(t.lastActivity()).toMatchObject({ action: 'items_replaced', before: '{"items_revision":1}', after: '{"items_revision":1}' })
    const price = await t.send('PUT', '/orders/2026-0022/items', { expectedVersion: 1, items: [{ ...items[0], unitPriceCents: 2400 }, items[1]] })
    expect(price.body).toMatchObject({ itemsRevision: 2 })
    expect(itemsOf(t, '2026-0022').map((i) => i.id)).toEqual(items.map((i) => i.id)) // ids kept
    const added = await t.send('PUT', '/orders/2026-0022/items', { expectedVersion: 2, items: [...asInput(t, '2026-0022'), { kind: 'charge', description: 'Setup', quantity: 1, unitPriceCents: 2500 }] })
    expect(added.body).toMatchObject({ itemsRevision: 3 })
  })
  test('changing the items of a ready order drops it back to awaiting_quote; a started order refuses', async () => {
    const t = setup()
    const items = asInput(t, '2026-0017')
    const res = await t.send('PUT', '/orders/2026-0017/items', { expectedVersion: 0, items: [{ ...items[0], quantity: 11 }, ...items.slice(1)] })
    expect(res.body).toMatchObject({ itemsRevision: 2, productionStatus: 'awaiting_quote' })
    for (const n of ['2026-0003', '2026-0004', '2026-0006']) await t.refused('PUT', `/orders/${n}/items`, { expectedVersion: 0, items: [] }, 409, 'production_started')
  })
  test("unknown or duplicate ids, sizes that don't add up, and a stale version are refused", async () => {
    const t = setup()
    const items = asInput(t, '2026-0022')
    await t.refused('PUT', '/orders/2026-0022/items', { expectedVersion: 0, items: [{ ...items[0], id: 1 }] }, 400, 'invalid_request')
    await t.refused('PUT', '/orders/2026-0022/items', { expectedVersion: 0, items: [items[0], items[0]] }, 400, 'invalid_request')
    await t.refused('PUT', '/orders/2026-0022/items', { expectedVersion: 0, items: [{ ...items[1], quantity: 41 }] }, 400, 'invalid_request')
    await t.refused('PUT', '/orders/2026-0022/items', { expectedVersion: 5, items }, 409, 'conflict_retry')
  })
})

describe('quotes', () => {
  test('a new version snapshots the items and supersedes the older open versions', async () => {
    const t = setup()
    const res = await t.send('POST', '/orders/2026-0023/quotes', { expectedVersion: t.v('2026-0023') })
    expect(res).toMatchObject({ status: 200, body: { quote: { version: 3, status: 'draft' } } })
    expect(quotesOf(t, '2026-0023').map((q) => [q.version, q.status])).toEqual([[1, 'superseded'], [2, 'superseded'], [3, 'draft']])
    expect(quotesOf(t, '2026-0023')[2]).toMatchObject({ items_revision: 1, total_cents: 6000 + 144000 + 36000 })
    expect(t.all('SELECT kind, product, line_total_cents FROM quote_items WHERE quote_id = (SELECT id FROM quotes WHERE order_id = 23 AND version = 3) ORDER BY position'))
      .toEqual([{ kind: 'product', product: 'Lanyard', line_total_cents: 6000 }, { kind: 'product', product: 'Polo shirt', line_total_cents: 144000 }, { kind: 'product', product: 'Tumbler', line_total_cents: 36000 }])
    expect(t.lastActivity()).toMatchObject({ action: 'quote_created', after: '{"quote_version":3,"items_revision":1}' })
    // An accepted quote is superseded by a new version too (order 17).
    await t.send('POST', '/orders/2026-0017/quotes', { expectedVersion: t.v('2026-0017') })
    expect(quotesOf(t, '2026-0017').map((q) => q.status)).toEqual(['superseded', 'draft'])
    expect(t.order('2026-0017').production_status).toBe('awaiting_quote')
  })
  test('a discount larger than the total is 409, nothing written', async () => {
    const t = setup()
    t.sqlite.exec(`INSERT INTO order_items (order_id, kind, description, quantity, unit_price_cents) VALUES (25, 'discount', 'Too much', 1, 999999)`)
    await t.refused('POST', '/orders/2026-0025/quotes', { expectedVersion: t.v('2026-0025') }, 409, 'discount_exceeds_total')
    expect(quotesOf(t, '2026-0025')).toEqual([])
  })
  test('send then accept: timestamps set, the status re-derived', async () => {
    const t = setup()
    await t.send('POST', '/orders/2026-0025/quotes', { expectedVersion: t.v('2026-0025') })
    const sent = await t.send('PATCH', '/orders/2026-0025/quotes/1', { expectedVersion: t.v('2026-0025'), to: 'sent' })
    expect(sent.body).toMatchObject({ quote: { version: 1, status: 'sent' }, productionStatus: 'awaiting_quote' })
    const accepted = await t.send('PATCH', '/orders/2026-0025/quotes/1', { expectedVersion: t.v('2026-0025'), to: 'accepted' })
    expect(accepted.body).toMatchObject({ quote: { status: 'accepted' }, productionStatus: 'awaiting_authorization' })
    expect(quotesOf(t, '2026-0025')[0]).toMatchObject({ status: 'accepted', sent_at: expect.any(String), decided_at: expect.any(String) })
    await t.refused('PATCH', '/orders/2026-0025/quotes/1', { expectedVersion: t.v('2026-0025'), to: 'declined' }, 409, 'invalid_quote_transition')
    await t.refused('PATCH', '/orders/2026-0025/quotes/9', { expectedVersion: t.v('2026-0025'), to: 'sent' }, 404, 'not_found')
  })
  test('accepting a quote made before the items changed is 409 quote_stale', async () => {
    const t = setup()
    t.sqlite.exec(`UPDATE order_items SET unit_price_cents = 1000 WHERE id = 51; UPDATE orders SET items_revision = 1 WHERE id = 25`)
    await t.send('POST', '/orders/2026-0025/quotes', { expectedVersion: t.v('2026-0025') })
    t.sqlite.exec(`UPDATE orders SET items_revision = 2 WHERE id = 25`)
    await t.refused('PATCH', '/orders/2026-0025/quotes/1', { expectedVersion: t.v('2026-0025'), to: 'accepted' }, 409, 'quote_stale')
    // Order 14 in the seed: v1 accepted at revision 1, items now at revision 2; a refresh of a new draft fixes it.
    expect(quotesOf(t, '2026-0025')[0]?.status).toBe('draft')
  })
  test('a charge-only quote is never accepted: refused by the route and by the trigger', async () => {
    const t = setup()
    const v = t.v('2026-0025')
    await t.send('PUT', '/orders/2026-0025/items', { expectedVersion: v, items: [{ kind: 'charge', description: 'Design fee', quantity: 1, unitPriceCents: 5000 }] })
    await t.send('POST', '/orders/2026-0025/quotes', { expectedVersion: t.v('2026-0025') })
    await t.refused('PATCH', '/orders/2026-0025/quotes/1', { expectedVersion: t.v('2026-0025'), to: 'accepted' }, 409, 'no_product_line')
    const o = t.order('2026-0025')
    const q = t.one<{ id: number }>('SELECT id FROM quotes WHERE order_id = 25')
    const before = t.activityCount()
    await expect(dbo.changeQuoteStatus(t.db, { orderId: o.id, version: o.version, actorId: 1, quoteId: q.id, quoteVersion: 1, from: 'draft', to: 'accepted' })).rejects.toThrow(/no_product_line/)
    expect(t.activityCount()).toBe(before)
    expect(t.order('2026-0025').version).toBe(o.version)
  })
  test('trigger errors reach the client as 409 with their code', async () => {
    const t = setup()
    await t.send('POST', '/orders/2026-0025/quotes', { expectedVersion: t.v('2026-0025') })
    t.sqlite.exec(`CREATE TEMP TRIGGER frozen BEFORE UPDATE OF status ON quotes BEGIN SELECT RAISE(ABORT, 'quote_frozen'); END`)
    await t.refused('PATCH', '/orders/2026-0025/quotes/1', { expectedVersion: t.v('2026-0025'), to: 'sent' }, 409, 'quote_frozen')
  })
  test('refresh re-snapshots a draft from the current items; a sent quote refuses', async () => {
    const t = setup()
    const items = itemsOf(t, '2026-0023')
    t.sqlite.exec(`UPDATE order_items SET unit_price_cents = 500 WHERE id = ${items[0]!.id}; UPDATE orders SET items_revision = 2 WHERE id = 23`)
    const res = await t.send('POST', '/orders/2026-0023/quotes/2/refresh', { expectedVersion: t.v('2026-0023') })
    expect(res.body).toMatchObject({ quote: { version: 2, status: 'draft' } })
    expect(quotesOf(t, '2026-0023')[1]).toMatchObject({ items_revision: 2, total_cents: 5000 + 144000 + 36000 })
    expect(t.lastActivity()).toMatchObject({ action: 'quote_refreshed' })
    await t.refused('POST', '/orders/2026-0022/quotes/1/refresh', { expectedVersion: t.v('2026-0022') }, 409, 'quote_not_draft')
  })
  test('duplicate copies a version back into the items and makes a new draft from it', async () => {
    const t = setup()
    // Order 23: v1 (superseded) has the old polo price 2400, v2 (draft) has 2200; the items carry 2400.
    t.sqlite.exec(`UPDATE order_items SET unit_price_cents = 2200 WHERE id = 46; UPDATE orders SET items_revision = 2 WHERE id = 23`)
    const res = await t.send('POST', '/orders/2026-0023/quotes/1/duplicate', { expectedVersion: t.v('2026-0023') })
    expect(res.body).toMatchObject({ quote: { version: 3, status: 'draft' }, itemsRevision: 3 })
    expect(itemsOf(t, '2026-0023').map((i) => [i.product, i.unit_price_cents])).toEqual([['Lanyard', 600], ['Polo shirt', 2400], ['Tumbler', 1800]])
    expect(quotesOf(t, '2026-0023').map((q) => [q.version, q.status, q.items_revision])).toEqual([[1, 'superseded', 1], [2, 'superseded', 1], [3, 'draft', 3]])
    // Duplicating what the items already are is not a customer-facing change.
    const again = await t.send('POST', '/orders/2026-0023/quotes/3/duplicate', { expectedVersion: t.v('2026-0023') })
    expect(again.body).toMatchObject({ quote: { version: 4 }, itemsRevision: 3 })
  })
})

describe('repeat order', () => {
  test('a new order for the same customer with the items only', async () => {
    const t = setup()
    const res = await t.send('POST', '/orders/2026-0015/repeat', { source: 'email', dueDate: '2026-12-15' })
    expect(res).toMatchObject({ status: 201, body: { productionStatus: 'awaiting_quote', itemsRevision: 0 } })
    const n = res.body.number
    expect(t.order(n)).toMatchObject({ customer_id: 4, contact_id: 7, title: 'Season jerseys (repeat)', source: 'email', due_date: '2026-12-15',
      po_required: 0, authorized_at: null, authorization_method: null, state: 'active' })
    const strip = (rows: ReturnType<typeof itemsOf>) => rows.map(({ id: _id, ...r }) => r)
    expect(strip(itemsOf(t, n))).toEqual(strip(itemsOf(t, '2026-0015')))
    const id = t.order(n).id
    for (const table of ['quotes', 'purchase_orders', 'artwork']) expect(t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE order_id = ?`, id).n).toBe(0)
    const logs = t.all<{ action: string; entity_id: number; after: string }>('SELECT action, entity_id, after FROM activity_log ORDER BY id DESC LIMIT 2')
    expect(logs).toEqual([
      { action: 'order_repeated', entity_id: 15, after: JSON.stringify({ order_number: n }) },
      { action: 'created', entity_id: id, after: JSON.stringify({ order_number: n, repeat_of: '2026-0015', production_status: 'awaiting_quote' }) },
    ])
  })
})

describe('direct authorization', () => {
  test('recorded only on a non-PO order, re-derives, and revoking drops a ready order back', async () => {
    const t = setup()
    await t.refused('POST', '/orders/2026-0005/authorization', { expectedVersion: t.v('2026-0005'), method: 'phone' }, 409, 'po_required')
    // Order 21: quote accepted, not authorized.
    const rec = await t.send('POST', '/orders/2026-0021/authorization', { expectedVersion: t.v('2026-0021'), method: 'signed_form', notes: 'Form on file' })
    expect(rec.body.productionStatus).toBe('awaiting_materials') // artwork approved, materials still needed
    expect(t.order('2026-0021')).toMatchObject({ authorized_by: 1, authorization_method: 'signed_form', authorization_notes: 'Form on file', authorized_at: expect.stringMatching(/Z$/) })
    // Order 17 is ready; revoking needs a reason and moves it back to awaiting_authorization.
    await t.refused('DELETE', '/orders/2026-0017/authorization', { expectedVersion: t.v('2026-0017') }, 400, 'invalid_request')
    const rev = await t.send('DELETE', '/orders/2026-0017/authorization', { expectedVersion: t.v('2026-0017'), reason: 'Customer withdrew approval' })
    expect(rev.body.productionStatus).toBe('awaiting_authorization')
    expect(t.order('2026-0017')).toMatchObject({ authorized_at: null, authorized_by: null, authorization_method: null, authorization_notes: null })
    const logs = t.all<{ action: string; after: string }>('SELECT action, after FROM activity_log WHERE entity_id = 17 ORDER BY id DESC LIMIT 2')
    expect(logs.map((l) => l.action)).toEqual(['production_status_changed', 'authorization_revoked'])
    expect(JSON.parse(logs[1]!.after)).toEqual({ reason: 'Customer withdrew approval' })
    await t.refused('DELETE', '/orders/2026-0017/authorization', { expectedVersion: t.v('2026-0017'), reason: 'again' }, 409, 'not_authorized')
  })
  // "The re-derive never moves an order in production or later" is parameterised over all three statuses below.
})

describe('cancel, reopen, notes', () => {
  test('cancelling a running job drops it to the derived pre-production status; reopening re-derives', async () => {
    const t = setup()
    t.sqlite.exec(`UPDATE purchase_orders SET status = 'rejected' WHERE id = 3`) // order 3 is in production
    await t.refused('POST', '/orders/2026-0003/cancel', { expectedVersion: t.v('2026-0003') }, 400, 'invalid_request')
    const res = await t.send('POST', '/orders/2026-0003/cancel', { expectedVersion: t.v('2026-0003'), reason: 'District cancelled the PO' })
    expect(res.body).toMatchObject({ state: 'cancelled', productionStatus: 'awaiting_authorization' })
    expect(JSON.parse(t.lastActivity().after!)).toEqual({ state: 'cancelled', production_status: 'awaiting_authorization', reason: 'District cancelled the PO' })
    await t.refused('POST', '/orders/2026-0003/cancel', { expectedVersion: t.v('2026-0003'), reason: 'again' }, 409, 'transition_not_allowed')
    await t.refused('PUT', '/orders/2026-0003/items', { expectedVersion: t.v('2026-0003'), items: [] }, 409, 'order_not_active')
    t.sqlite.exec(`UPDATE purchase_orders SET status = 'approved' WHERE id = 3`)
    const reopened = await t.send('POST', '/orders/2026-0003/reopen', { expectedVersion: t.v('2026-0003') })
    expect(reopened.body).toMatchObject({ state: 'active', productionStatus: 'ready' })
    await t.refused('POST', '/orders/2026-0003/reopen', { expectedVersion: t.v('2026-0003') }, 409, 'transition_not_allowed')
    await t.refused('POST', '/orders/2026-0001/reopen', { expectedVersion: t.v('2026-0001') }, 409, 'transition_not_allowed') // closed is not reopened
  })
  test('a note is stored with its author and logged without its body', async () => {
    const t = setup()
    const res = await t.call('POST', '/orders/2026-0022/notes', { body: 'Customer wants a proof first.' })
    expect(res.status).toBe(201)
    expect(t.one('SELECT entity_id, author_id, body FROM notes ORDER BY id DESC LIMIT 1')).toEqual({ entity_id: 22, author_id: 1, body: 'Customer wants a proof first.' })
    expect(t.lastActivity()).toEqual({ action: 'note_added', entity_id: 22, before: null, after: null })
    await t.refused('POST', '/orders/2026-0022/notes', { body: '  ' }, 400, 'invalid_request')
  })
})

describe('atomicity and vocabulary', () => {
  test('a failing activity insert rolls back every write', async () => {
    const t = setup()
    t.sqlite.exec(`CREATE TEMP TRIGGER boom BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    const snapshot = () => JSON.stringify([t.all('SELECT * FROM orders'), t.all('SELECT * FROM order_items'), t.all('SELECT * FROM quotes'), t.all('SELECT * FROM counters'), t.all('SELECT * FROM notes')])
    const before = snapshot()
    for (const [method, path, body] of [
      ['POST', '/orders', { customerId: 6, source: 'phone', title: 'x', items: [tee] }],
      ['PATCH', '/orders/2026-0022', { expectedVersion: 0, title: 'x' }],
      ['PUT', '/orders/2026-0022/items', { expectedVersion: 0, items: [tee] }],
      ['POST', '/orders/2026-0023/quotes', { expectedVersion: t.v('2026-0023') }],
      ['PATCH', '/orders/2026-0022/quotes/1', { expectedVersion: t.v('2026-0022'), to: 'accepted' }],
      ['POST', '/orders/2026-0015/repeat', { source: 'phone' }],
      ['POST', '/orders/2026-0021/authorization', { expectedVersion: t.v('2026-0021'), method: 'phone' }],
      ['POST', '/orders/2026-0022/cancel', { expectedVersion: t.v('2026-0022'), reason: 'x' }],
      ['POST', '/orders/2026-0022/notes', { body: 'x' }],
    ] as const) expect((await t.call(method, path, body)).status, `${method} ${path}`).toBe(500)
    expect(snapshot()).toBe(before)
  })
  test('the writes log only codes from ACTIVITY_ACTIONS', async () => {
    const t = setup()
    await t.send('PATCH', '/orders/2026-0016', { expectedVersion: 0, materialsRequired: false, confirmNoPurchasing: true, title: 'x' })
    await t.send('POST', '/orders/2026-0023/quotes', { expectedVersion: t.v('2026-0023') })
    await t.send('PATCH', '/orders/2026-0023/quotes/3', { expectedVersion: t.v('2026-0023'), to: 'sent' })
    await t.send('POST', '/orders/2026-0023/quotes/1/duplicate', { expectedVersion: t.v('2026-0023') })
    await t.send('POST', '/orders/2026-0023/quotes/4/refresh', { expectedVersion: t.v('2026-0023') })
    await t.send('POST', '/orders/2026-0015/repeat', { source: 'phone' })
    await t.send('POST', '/orders/2026-0021/authorization', { expectedVersion: t.v('2026-0021'), method: 'phone' })
    await t.send('DELETE', '/orders/2026-0021/authorization', { expectedVersion: t.v('2026-0021'), reason: 'x' })
    await t.send('PATCH', '/orders/2026-0022', { expectedVersion: 0, title: 'y' })
    await t.send('POST', '/orders/2026-0022/cancel', { expectedVersion: t.v('2026-0022'), reason: 'x' })
    await t.send('POST', '/orders/2026-0022/reopen', { expectedVersion: t.v('2026-0022') })
    await t.call('POST', '/orders/2026-0022/notes', { body: 'x' })
    await t.send('PUT', '/orders/2026-0025/items', { expectedVersion: 0, items: [tee] })
    const actions = t.all<{ action: string }>('SELECT DISTINCT action FROM activity_log').map((r) => r.action)
    for (const a of actions) expect(ACTIVITY_ACTIONS as readonly string[]).toContain(a)
    // Customer and contact actions are the customers API's (covered in customers.test.ts); artwork and PO ones are
    // covered in artwork.test.ts and purchase-orders.test.ts.
    const customerSide = ['customer_created', 'customer_updated', 'contact_added', 'contact_updated', 'contact_archived', 'contact_unarchived',
      'artwork_uploaded', 'artwork_decided', 'po_created', 'po_details_updated', 'po_document_added']
    expect(ACTIVITY_ACTIONS.filter((a) => !actions.includes(a) && !customerSide.includes(a))).toEqual(['po_status_changed'])
  })
})

describe('business dates', () => {
  test('dashboard "today" is the shop date: at 04:30 UTC on Nov 1 it is still Oct 31 in Chicago', async () => {
    const t = setup(false)
    t.sqlite.exec(`INSERT INTO orders (number, customer_id, source, title, due_date) VALUES ('2026-0001', 1, 'phone', 'a', '2026-10-30'), ('2026-0002', 1, 'phone', 'b', '2026-10-31')`)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-01T04:30:00Z'))
    const d = (await (await t.call('GET', '/dashboard')).json()) as DashboardResponse
    expect(d.metrics.dueIn7Days).toEqual({ count: 1, overdue: 1 }) // UTC would say both overdue
    expect(d.dueThisWeek.map((r) => r.number)).toEqual(['2026-0002'])
    expect(d.needsAttention.map((r) => [r.number, r.reason, r.reasonDays])).toEqual([['2026-0001', 'overdue', 1]])
  })
})

// ---- Codex review of cce1dc9 ----

/** A D1 that runs `act` right after the first read whose SQL contains `match`: a write landing between the route's read and its batch. */
function afterRead(db: T['db'], match: string, act: () => void): T['db'] {
  let done = false
  type S = { bind: (...v: unknown[]) => S; first: (c?: string) => Promise<unknown> }
  const wrap = (s: S): S => ({
    ...s,
    bind: (...v) => wrap(s.bind(...v)),
    first: async (c) => {
      const r = await s.first(c)
      if (!done) {
        done = true
        act()
      }
      return r
    },
  })
  const d = db as unknown as { prepare: (sql: string) => S; batch: unknown }
  return { prepare: (sql: string) => (sql.includes(match) ? wrap(d.prepare(sql)) : d.prepare(sql)), batch: d.batch } as unknown as T['db']
}
const CONTACT_READ = 'FROM customer_contacts WHERE id = ?'
const archive = (t: T, contactId: number) => t.sqlite.exec(`UPDATE customer_contacts SET archived_at = '2026-10-01T00:00:00Z' WHERE id = ${contactId}`)
const ledger = (t: T) => JSON.stringify([t.all('SELECT * FROM counters'), t.all('SELECT id, number FROM orders'), t.activityCount()])

describe('Codex review of cce1dc9', () => {
  test('replace items: a new line placed before the retained max-id item never takes its id', async () => {
    const t = setup()
    const n = (await t.send('POST', '/orders', { customerId: 6, source: 'phone', title: 'x', items: [tee] })).body.number
    const [kept] = itemsOf(t, n)
    expect(kept!.id).toBe(t.one<{ m: number }>('SELECT MAX(id) AS m FROM order_items').m) // the table's last row
    const res = await t.send('PUT', `/orders/${n}/items`, { expectedVersion: 0, items: [{ ...tee, product: 'New hoodie' }, { ...tee, id: kept!.id, notes: 'kept' }] })
    expect(res.status).toBe(200)
    const after = itemsOf(t, n)
    expect(after).toHaveLength(2)
    expect(after.find((i) => i.id === kept!.id)).toMatchObject({ product: 'Gildan tee', notes: 'kept' })
    expect(after.find((i) => i.id !== kept!.id)).toMatchObject({ product: 'New hoodie' })
    // A removed line is deleted, a retained one keeps its id.
    await t.send('PUT', `/orders/${n}/items`, { expectedVersion: 1, items: [{ ...tee, id: kept!.id }] })
    expect(itemsOf(t, n).map((i) => i.id)).toEqual([kept!.id])
  })

  test('repeat: a source whose contact is archived is refused, no order, no number used', async () => {
    const t = setup()
    archive(t, 7) // order 15's contact
    const before = ledger(t)
    await t.refused('POST', '/orders/2026-0015/repeat', { source: 'email' }, 409, 'contact_archived')
    expect(ledger(t)).toBe(before)
    // The SQL holds the same rule when the archive lands after the route's check.
    expect(await dbo.repeatOrder(t.db, { year: 2026, actorId: 1, sourceId: 15, source: 'email', dueDate: null, productionStatus: 'awaiting_quote' })).toBeNull()
    expect(ledger(t)).toBe(before)
  })

  test('header: a contact archived between the route read and the batch is 409 contact_archived, nothing applied or logged', async () => {
    const t = setup()
    const o = t.order('2026-0007')
    const before = ledger(t)
    const res = await t.call('PATCH', '/orders/2026-0007', { expectedVersion: 0, contactId: 2 }, true, afterRead(t.db, CONTACT_READ, () => archive(t, 2)))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('contact_archived')
    expect(t.order('2026-0007')).toMatchObject({ contact_id: o.contact_id, version: o.version })
    expect(ledger(t)).toBe(before)
    // db level: the guarded UPDATE itself refuses.
    expect(await dbo.updateOrderHeader(t.db, { orderId: o.id, version: o.version, actorId: 1, changes: { contactId: 2 }, before: { contactId: o.contact_id as number }, noPurchasing: false })).toBeNull()
    expect(ledger(t)).toBe(before)
  })

  test('create: a contact archived just before the batch is refused and uses no order number', async () => {
    const t = setup()
    const before = ledger(t)
    const res = await t.call('POST', '/orders', { customerId: 1, contactId: 2, source: 'phone', title: 'x', items: [tee] }, true, afterRead(t.db, CONTACT_READ, () => archive(t, 2)))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('contact_archived')
    expect(ledger(t)).toBe(before)
    expect(await dbo.createOrder(t.db, { year: 2026, actorId: 1, customerId: 1, contactId: 2, source: 'phone', title: 'x', dueDate: null, poRequired: true,
      paymentTerms: 'due_after_pickup', artworkRequired: true, productionStatus: 'awaiting_quote', items: [{ ...tee, notes: null, description: null } as dbo.ItemWrite] })).toBeNull()
    expect(ledger(t)).toBe(before)
  })

  test('expectedVersion is required on every guarded write: omitted is 400, nothing written', async () => {
    const t = setup()
    await t.send('POST', '/orders/2026-0025/quotes', { expectedVersion: 0 })
    for (const [method, path, body] of [
      ['POST', '/orders/2026-0023/quotes', {}],
      ['POST', '/orders/2026-0023/quotes/2/refresh', {}],
      ['POST', '/orders/2026-0023/quotes/1/duplicate', {}],
      ['PATCH', '/orders/2026-0025/quotes/1', { to: 'sent' }],
      ['POST', '/orders/2026-0021/authorization', { method: 'phone' }],
      ['DELETE', '/orders/2026-0017/authorization', { reason: 'x' }],
      ['POST', '/orders/2026-0022/cancel', { reason: 'x' }],
      ['POST', '/orders/2026-0024/reopen', {}],
    ] as const) await t.refused(method, path, body, 400, 'invalid_request')
  })

  test('two staff from the same version: the second is 409 and its stale values are not applied', async () => {
    const t = setup()
    // Both read order 17 at version 0 (authorized in person). A revokes; B, still looking at v0, re-records.
    expect((await t.send('DELETE', '/orders/2026-0017/authorization', { reason: 'Customer withdrew', expectedVersion: 0 })).status).toBe(200)
    await t.refused('POST', '/orders/2026-0017/authorization', { method: 'phone', expectedVersion: 0 }, 409, 'conflict_retry')
    await t.refused('POST', '/orders/2026-0017/cancel', { reason: 'x', expectedVersion: 0 }, 409, 'conflict_retry')
    expect(t.order('2026-0017')).toMatchObject({ authorized_at: null, authorization_method: null, state: 'active', production_status: 'awaiting_authorization' })
  })

  test('the route refuses an unacceptable snapshot on its own, not only through the trigger', async () => {
    const t = setup()
    await t.send('POST', '/orders/2026-0025/quotes', { expectedVersion: 0 })
    // Sizes that don't add up: a product line is present, so quotes_accept_needs_product lets it through.
    t.sqlite.exec(`UPDATE quote_items SET sizes = '{"M":1}' WHERE kind = 'product' AND quote_id = (SELECT id FROM quotes WHERE order_id = 25)`)
    await t.refused('PATCH', '/orders/2026-0025/quotes/1', { to: 'accepted', expectedVersion: t.v('2026-0025') }, 409, 'invalid_request')
    expect(quotesOf(t, '2026-0025')[0]?.status).toBe('draft')
    // Proof the database alone would have accepted it.
    const o = t.order('2026-0025')
    const q = t.one<{ id: number }>('SELECT id FROM quotes WHERE order_id = 25')
    expect(await dbo.changeQuoteStatus(t.db, { orderId: o.id, version: o.version, actorId: 1, quoteId: q.id, quoteVersion: 1, from: 'draft', to: 'accepted' })).not.toBeNull()
  })

  test.each(['in_production', 'quality_control', 'production_complete'])('the re-derive never moves an order at %s', async (status) => {
    const t = setup()
    // Order 19 is on a direct authorization; revoking it would drop a pre-production order to awaiting_authorization.
    t.sqlite.exec(`UPDATE orders SET production_status = '${status}' WHERE id = 19`)
    const res = await t.send('DELETE', '/orders/2026-0019/authorization', { reason: 'x', expectedVersion: t.v('2026-0019') })
    expect(res).toMatchObject({ status: 200, body: { productionStatus: status } })
    expect(t.order('2026-0019')).toMatchObject({ production_status: status, authorized_at: null })
  })
})
