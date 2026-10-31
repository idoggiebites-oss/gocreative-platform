import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { Hono } from 'hono'
import { appRoutes } from '../../worker/routes/app'
import type { AppEnv } from '../../worker/auth'
import type { CustomerDetailResponse, CustomersListResponse, CustomerResponse, ContactResponse, NoteResponse } from '../../shared/api'
import { createTestD1 } from './d1'
import { getContact, updateContact, updateCustomer } from '../../worker/db/customers'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')

function setup() {
  const { db, sqlite } = createTestD1()
  sqlite.exec(seed)
  const app = new Hono<AppEnv>().route('/api/app', appRoutes())
  const call = (method: string, path: string, body?: unknown, auth = true) =>
    app.request(
      `http://localhost/api/app${path}`,
      { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
      auth ? { DB: db, DEV_AUTH_EMAIL: 'owner1@example.com' } : { DB: db, ACCESS_AUD: 'a', ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com' },
    )
  const json = async <T>(res: Response) => (await res.json()) as T
  const one = <T>(sql: string, ...p: (string | number)[]) => sqlite.prepare(sql).get(...p) as T
  const activityCount = () => one<{ n: number }>('SELECT COUNT(*) AS n FROM activity_log').n
  const boom = () => sqlite.exec(`CREATE TEMP TRIGGER boom BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT, 'boom'); END`)
  const detail = async (id: number) => json<CustomerDetailResponse>(await call('GET', `/customers/${id}`))
  return { db, sqlite, call, json, one, activityCount, boom, detail }
}

describe('customers auth', () => {
  test('401 without auth on every endpoint', async () => {
    const t = setup()
    for (const [method, path] of [
      ['GET', '/customers'], ['GET', '/customers/1'], ['POST', '/customers'], ['PATCH', '/customers/1'],
      ['POST', '/customers/1/contacts'], ['PATCH', '/customers/1/contacts/1'],
      ['POST', '/customers/1/contacts/1/archive'], ['POST', '/customers/1/contacts/1/unarchive'], ['POST', '/customers/1/notes'],
    ]) {
      expect((await t.call(method!, path!, method === 'GET' ? undefined : {}, false)).status, `${method} ${path}`).toBe(401)
    }
  })
})

describe('customers list', () => {
  test('search by contact name, case-insensitive; kind filter; sorted by name', async () => {
    const t = setup()
    const list = async (qs: string) => (await t.json<CustomersListResponse>(await t.call('GET', `/customers?${qs}`))).rows
    expect((await list('q=HELEN%20marsh')).map((r) => r.id)).toEqual([1])
    expect((await list('q=riverbend')).map((r) => r.id)).toEqual([1])
    expect((await list('q=%25')).length).toBe(0) // wildcards are literal
    expect((await list('q=x%27%20OR%201=1--')).length).toBe(0)
    const districts = await list('kind=district')
    expect(districts.map((r) => r.kind)).toEqual(['district', 'district', 'district'])
    const all = await list('')
    expect(all.map((r) => r.name)).toEqual([...all.map((r) => r.name)].sort((a, b) => a.localeCompare(b)))
    expect((await list('limit=2')).length).toBe(2)
    expect((await t.call('GET', '/customers?limit=201')).status).toBe(400)
    const r1 = all.find((r) => r.id === 1)!
    expect(r1.outstanding).toBeNull()
    expect(r1.activeOrders).toBe(t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE customer_id = 1 AND state = 'active'`).n)
    expect(r1.lastOrderAt).toBe(t.one<{ m: string }>('SELECT MAX(created_at) AS m FROM orders WHERE customer_id = 1').m)
  })
  test('archived contacts stay searchable; archived contact is hidden from nothing in history', async () => {
    const t = setup()
    await t.call('POST', '/customers/1/contacts/1/archive')
    const d = await t.detail(1)
    expect(d.contacts.at(-1)).toMatchObject({ id: 1, archived: true, isPrimary: false })
    expect(d.contacts[0]?.archived).toBe(false)
    // orders still reference it
    expect(t.one<{ n: number }>('SELECT COUNT(*) AS n FROM orders WHERE contact_id = 1').n).toBeGreaterThan(0)
  })
})

describe('customer detail', () => {
  test('never includes another customer data or user emails', async () => {
    const t = setup()
    await t.call('POST', '/customers/2/notes', { body: 'other customer note' })
    await t.call('POST', '/customers/1/notes', { body: 'mine' })
    const d = await t.detail(1)
    expect(d.contacts.map((c) => c.id).sort()).toEqual([1, 2])
    const mine = t.sqlite.prepare('SELECT number FROM orders WHERE customer_id = 1').all() as { number: string }[]
    expect(d.orders.map((o) => o.number).sort()).toEqual(mine.map((o) => o.number).sort())
    expect(d.notes.map((n) => n.body)).toContain('mine')
    expect(d.notes.map((n) => n.body)).not.toContain('other customer note')
    expect(d.notes[0]?.body).toBe('mine') // newest first
    expect(d.notes[0]?.authorName).toBe('Owner One')
    expect(JSON.stringify(d)).not.toMatch(/owner1@example\.com|owner2@example\.com/)
    expect(Object.keys(d.notes[0]!).sort()).toEqual(['authorName', 'body', 'createdAt', 'id'])
    for (const a of d.activity) expect(Object.keys(a).sort()).toEqual(['action', 'actor', 'after', 'before', 'createdAt', 'id'])
    expect((await t.call('GET', '/customers/999')).status).toBe(404)
    expect((await t.call('GET', '/customers/abc')).status).toBe(400)
  })
})

describe('customer create / patch', () => {
  test('kind defaults apply when omitted, explicit values win', async () => {
    const t = setup()
    const make = async (b: object) => (await t.json<CustomerResponse>(await t.call('POST', '/customers', b))).customer
    expect(await make({ name: 'D', kind: 'district' })).toMatchObject({ defaultPoRequired: true, defaultPaymentTerms: 'due_after_pickup' })
    expect(await make({ name: 'O', kind: 'organization' })).toMatchObject({ defaultPoRequired: true, defaultPaymentTerms: 'due_after_pickup' })
    expect(await make({ name: 'I', kind: 'individual' })).toMatchObject({ defaultPoRequired: false, defaultPaymentTerms: 'due_at_pickup' })
    expect(await make({ name: 'I2', kind: 'individual', defaultPoRequired: true })).toMatchObject({ defaultPoRequired: true, defaultPaymentTerms: 'due_at_pickup' })
  })
  test('validation: 400 invalid_request', async () => {
    const t = setup()
    for (const b of [{ kind: 'district' }, { name: 'x', kind: 'nope' }, { name: 'x', kind: 'district', email: 'not-an-email' }, { name: 'x', kind: 'district', phone: 'abc' }]) {
      const res = await t.call('POST', '/customers', b)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: 'invalid_request' })
    }
    expect((await t.call('POST', '/customers', { name: 'x', kind: 'district', phone: '(555) 010-2030 ext. 4', email: 'a@b.co' })).status).toBe(201)
  })
  test('patch conflict guard', async () => {
    const t = setup()
    const before = (await t.detail(1)).customer
    const ok = await t.call('PATCH', '/customers/1', { name: 'Riverbend USD', expectedVersion: before.version })
    expect(ok.status).toBe(200)
    const orderTerms = t.one<{ s: string }>(`SELECT group_concat(payment_terms || po_required) AS s FROM orders WHERE customer_id = 1`).s
    const stale = await t.call('PATCH', '/customers/1', { name: 'Late', expectedVersion: before.version })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'conflict_retry' })
    const now = (await t.detail(1)).customer
    expect(now.name).toBe('Riverbend USD')
    expect(now.version).toBe(before.version + 1)
    // defaults change never rewrites existing orders
    await t.call('PATCH', '/customers/1', { defaultPoRequired: false, defaultPaymentTerms: 'due_at_pickup', expectedVersion: now.version })
    expect(t.one<{ s: string }>(`SELECT group_concat(payment_terms || po_required) AS s FROM orders WHERE customer_id = 1`).s).toBe(orderTerms)
    expect((await t.call('PATCH', '/customers/1', { expectedVersion: now.version })).status).toBe(400)
    expect((await t.call('PATCH', '/customers/999', { name: 'x', expectedVersion: 0 })).status).toBe(404)
  })
})

describe('contacts', () => {
  const primaries = (t: ReturnType<typeof setup>, id: number) => t.one<{ n: number }>('SELECT COUNT(*) AS n FROM customer_contacts WHERE customer_id = ? AND is_primary = 1', id).n
  test('at most one primary per customer', async () => {
    const t = setup()
    expect(primaries(t, 1)).toBe(1)
    const r = await t.call('PATCH', '/customers/1/contacts/2', { isPrimary: true })
    expect(r.status).toBe(200)
    expect(primaries(t, 1)).toBe(1)
    expect(t.one<{ id: number }>('SELECT id FROM customer_contacts WHERE customer_id = 1 AND is_primary = 1').id).toBe(2)
    const add = await t.json<ContactResponse>(await t.call('POST', '/customers/1/contacts', { name: 'New Person', isPrimary: true, email: 'n@x.co' }))
    expect(add.contact).toMatchObject({ name: 'New Person', isPrimary: true, archived: false })
    expect(primaries(t, 1)).toBe(1)
    expect(primaries(t, 2)).toBe(1) // other customers untouched
  })
  test('archive keeps history, unarchive restores, double archive is 409, archived cannot be primary', async () => {
    const t = setup()
    const a = await t.call('POST', '/customers/1/contacts/1/archive')
    expect(a.status).toBe(200)
    expect((await t.json<ContactResponse>(a)).contact).toMatchObject({ archived: true, isPrimary: false })
    expect(t.one<{ n: number }>('SELECT COUNT(*) AS n FROM customer_contacts WHERE id = 1').n).toBe(1)
    expect((await t.call('POST', '/customers/1/contacts/1/archive')).status).toBe(409)
    expect((await t.call('PATCH', '/customers/1/contacts/1', { isPrimary: true })).status).toBe(409)
    const u = await t.call('POST', '/customers/1/contacts/1/unarchive')
    expect((await t.json<ContactResponse>(u)).contact.archived).toBe(false)
    expect((await t.call('POST', '/customers/1/contacts/1/unarchive')).status).toBe(409)
  })
  test('a contact of another customer is 404 on every contact route', async () => {
    const t = setup()
    const before = t.activityCount()
    expect((await t.call('PATCH', '/customers/1/contacts/3', { name: 'Hijack' })).status).toBe(404)
    expect((await t.call('POST', '/customers/1/contacts/3/archive')).status).toBe(404)
    expect((await t.call('POST', '/customers/1/contacts/3/unarchive')).status).toBe(404)
    expect(t.one<{ name: string }>('SELECT name FROM customer_contacts WHERE id = 3').name).toBe('Rosa Delgado')
    expect(t.activityCount()).toBe(before)
  })
})

describe('writes are logged atomically', () => {
  const writes: [string, string, (u: number) => unknown][] = [
    ['POST', '/customers', () => ({ name: 'N', kind: 'individual' })],
    ['PATCH', '/customers/1', (u) => ({ name: 'Renamed', expectedVersion: u })],
    ['POST', '/customers/1/contacts', () => ({ name: 'C', isPrimary: true })],
    ['PATCH', '/customers/1/contacts/2', () => ({ title: 'Boss', isPrimary: true })],
    ['POST', '/customers/1/contacts/2/archive', () => undefined],
    ['POST', '/customers/1/contacts/2/unarchive', () => undefined],
    ['POST', '/customers/1/notes', () => ({ body: 'hello' })],
  ]
  test('each write leaves exactly one activity row, in the same transaction as the change', async () => {
    const t = setup()
    for (const [method, path, body] of writes) {
      const u = (await t.detail(1)).customer.version
      const before = t.activityCount()
      const res = await t.call(method, path, body(u) ?? {})
      expect(res.status, `${method} ${path}`).toBeLessThan(300)
      expect(t.activityCount() - before, `${method} ${path}`).toBe(1)
      const row = t.one<{ actor_id: number; actor_kind: string; entity_type: string }>('SELECT actor_id, actor_kind, entity_type FROM activity_log ORDER BY id DESC LIMIT 1')
      expect(row).toEqual({ actor_id: 1, actor_kind: 'user', entity_type: 'customer' })
    }
  })
  test('a failing write leaves nothing behind', async () => {
    const t = setup()
    t.boom()
    const snap = () => JSON.stringify([
      t.sqlite.prepare('SELECT * FROM customers ORDER BY id').all(), t.sqlite.prepare('SELECT * FROM customer_contacts ORDER BY id').all(),
      t.sqlite.prepare('SELECT * FROM notes ORDER BY id').all(),
    ])
    t.sqlite.exec(`UPDATE customer_contacts SET archived_at = '2026-01-01T00:00:00.000Z', is_primary = 0 WHERE id = 1`) // so unarchive has something to do
    const s = snap()
    const u = (await t.detail(1)).customer.version
    for (const [method, path, body] of [...writes.filter((w) => !w[1].endsWith('/unarchive') && !w[1].endsWith('/2/archive')), ['POST', '/customers/1/contacts/1/unarchive', () => undefined] as (typeof writes)[number], ['POST', '/customers/1/contacts/2/archive', () => undefined] as (typeof writes)[number]]) {
      const res = await t.call(method, path, body(u) ?? {})
      expect(res.status, `${method} ${path}`).toBe(500)
    }
    expect(snap()).toBe(s)
  })
  test('note: 400 on blank body, 404 on unknown customer', async () => {
    const t = setup()
    expect((await t.call('POST', '/customers/1/notes', { body: '  ' })).status).toBe(400)
    expect((await t.call('POST', '/customers/999/notes', { body: 'x' })).status).toBe(404)
    const n = await t.json<NoteResponse>(await t.call('POST', '/customers/1/notes', { body: ' hi ' }))
    expect(n.note).toMatchObject({ body: 'hi', authorName: 'Owner One' })
    expect(t.one<{ entity_type: string }>('SELECT entity_type FROM notes WHERE id = ?', n.note.id).entity_type).toBe('customer')
  })
})

describe('review fixes (Codex, 7d3b560)', () => {
  test('promoting a contact archived after the route read changes nothing and logs nothing', async () => {
    const t = setup()
    const stale = (await getContact(t.db, 1, 2))! // read while active
    t.sqlite.exec(`UPDATE customer_contacts SET archived_at = '2026-01-01T00:00:00.000Z' WHERE id = 2`) // archived between read and batch
    const before = t.activityCount()
    expect(await updateContact(t.db, 1, 1, stale, { isPrimary: true })).toBe(false)
    expect(t.one<{ is_primary: number }>('SELECT is_primary FROM customer_contacts WHERE id = 2').is_primary).toBe(0)
    expect(t.one<{ id: number }>('SELECT id FROM customer_contacts WHERE customer_id = 1 AND is_primary = 1').id).toBe(1)
    expect(t.activityCount()).toBe(before)
  })
  test('stale version is rejected by the SQL guard: intervening value kept, nothing extra logged', async () => {
    const t = setup()
    const stale = (await t.detail(1)).customer
    expect(await updateCustomer(t.db, 1, stale, { name: 'First' }, stale.version)).toBe(true) // the intervening update
    const before = t.activityCount()
    expect(await updateCustomer(t.db, 1, stale, { name: 'Second' }, stale.version)).toBe(false) // same stale version
    expect(t.one<{ name: string; version: number }>('SELECT name, version FROM customers WHERE id = 1')).toEqual({ name: 'First', version: stale.version + 1 })
    expect(t.activityCount()).toBe(before)
  })
  test("detail activity is exactly this customer's rows", async () => {
    const t = setup()
    await t.call('POST', '/customers/1/notes', { body: 'a' })
    await t.call('POST', '/customers/2/notes', { body: 'b' })
    await t.call('POST', '/customers/2/notes', { body: 'c' })
    const ids = (c: number) => (t.sqlite.prepare(`SELECT id FROM activity_log WHERE entity_type = 'customer' AND entity_id = ? ORDER BY id DESC`).all(c) as { id: number }[]).map((r) => r.id)
    expect(ids(1).length).toBeGreaterThan(0)
    expect(ids(2).length).toBeGreaterThan(0)
    expect((await t.detail(1)).activity.map((a) => a.id)).toEqual(ids(1))
    expect((await t.detail(2)).activity.map((a) => a.id)).toEqual(ids(2))
  })
})
