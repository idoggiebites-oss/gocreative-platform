// Pricing Management over the real routes. Rates are test numbers only.
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { app } from '../../worker/index'
import { createTestD1 } from './d1'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
const CONFIG = { productCostCents: { tshirts: 300 }, services: { dtg: { adjustmentBps: 0, pricing: { mode: 'markup', rateBps: 10000 }, sizeCostTiers: { medium: [{ minQty: 1, costCents: 200 }] } } } }
const REQUEST = { lines: [{ product: 'tshirts', method: 'dtg', quantity: 5, decorations: [{ size: 'medium' }] }] }
const STAFF = 'staff9@example.com'

function setup() {
  const { db, sqlite } = createTestD1()
  sqlite.exec(seed)
  sqlite.exec(`INSERT INTO users (email, name, role, active) VALUES ('${STAFF}', 'Staff', 'staff', 1)`)
  const call = (method: string, path: string, body?: unknown, as = 'owner1@example.com') => app.request(`http://localhost/api/app${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: db, DEV_AUTH_EMAIL: as } as unknown as Env)
  const state = async () => (await call('GET', '/pricing')).json() as Promise<{ active: { id: number; hash: string } | null; draft: { id: number; hash: string; rollbackOf: number | null } | null; versions: { id: number; status: string }[] }>
  const publish = async (config: object, expectedActiveId: number | null) => {
    const s = await state()
    const saved = await call('PUT', '/pricing/draft', { config, expectedHash: s.draft?.hash ?? null })
    expect(saved.status).toBe(200)
    const d = (await state()).draft!
    expect((await call('POST', '/pricing/publish', { draftId: d.id, draftHash: d.hash, expectedActiveId })).status).toBe(200)
    return d.id
  }
  const n = (sql: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n
  return { db, sqlite, call, state, publish, n }
}

test('only owners: every pricing route refuses staff, and refuses anyone not signed in', async () => {
  const t = setup()
  const id = await t.publish(CONFIG, null)
  const routes: [string, string, unknown][] = [
    ['GET', '/pricing', undefined], ['PUT', '/pricing/draft', { config: CONFIG, expectedHash: null }], ['DELETE', '/pricing/draft', { hash: 'a'.repeat(64) }],
    ['POST', '/pricing/simulate', { request: REQUEST, config: CONFIG }], ['POST', '/pricing/publish', { draftId: 1, draftHash: 'a'.repeat(64), expectedActiveId: null }], ['POST', `/pricing/versions/${id}/restore`, { expectedHash: null }],
  ]
  for (const [method, path, body] of routes) {
    const res = await t.call(method, path, body, STAFF)
    expect(res.status, `${method} ${path}`).toBe(403)
    expect(await res.text()).not.toMatch(/cost|margin|tshirts/i)
    const anon = await app.request(`https://gocreative.test/api/app${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: t.db, ACCESS_AUD: 'a', ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com' } as unknown as Env)
    expect(anon.status, `${method} ${path}`).toBe(401)
  }
  expect(t.n("pricing_versions WHERE status = 'draft'")).toBe(0)
})

test('nothing pricing-related reaches staff or the public by another route', async () => {
  const t = setup()
  await t.publish(CONFIG, null)
  for (const path of ['/dashboard', '/orders', '/me', '/users']) {
    const text = await (await t.call('GET', path, undefined, STAFF)).text()
    expect(text, path).not.toMatch(/costCents|productCost|rateBps/)
  }
  const pub = await app.request('http://localhost/api/public/status', {}, { DB: t.db } as unknown as Env)
  expect(await pub.text()).not.toMatch(/cost|margin|rate/i)
  expect((await app.request('http://localhost/api/public/pricing', {}, { DB: t.db } as unknown as Env)).status).toBe(404)
})

test('a draft affects nothing live, and the simulator compares published with proposed and writes nothing', async () => {
  const t = setup()
  const v1 = await t.publish(CONFIG, null)
  const raised = { ...CONFIG, services: { dtg: { ...CONFIG.services.dtg, adjustmentBps: 1000 } } }
  await t.call('PUT', '/pricing/draft', { config: raised, expectedHash: null })
  expect((await t.state()).active!.id).toBe(v1)
  const before = t.n('pricing_versions')
  const res = await t.call('POST', '/pricing/simulate', { request: REQUEST, config: raised })
  const sim = await res.json() as { current: { totalCents: number; costCents: number; marginBps: number }; proposed: { totalCents: number }; differenceCents: number }
  expect(sim.current.totalCents).toBe(5000) // (300 + 200) × 2 × 5
  expect(sim.proposed.totalCents).toBe(5500)
  expect(sim.differenceCents).toBe(500)
  expect(sim.current.costCents).toBe(2500)
  expect(sim.current.marginBps).toBe(5000)
  expect(t.n('pricing_versions')).toBe(before)
})

test('with nothing published, the simulator shows manual review, not a price', async () => {
  const t = setup()
  const sim = await (await t.call('POST', '/pricing/simulate', { request: REQUEST, config: null })).json() as { current: { status: string; totalCents: null }; proposed: { status: string }; differenceCents: null }
  expect(sim.current).toMatchObject({ status: 'manual_review_required', totalCents: null })
  expect(sim.proposed.status).toBe('manual_review_required')
  expect(sim.differenceCents).toBeNull()
})

test('invalid values are refused and write nothing: impossible margins, unknown fields, negative money', async () => {
  const t = setup()
  for (const config of [
    { ...CONFIG, services: { dtg: { adjustmentBps: 0, pricing: { mode: 'margin', rateBps: 10000 }, sizeCostTiers: {} } } },
    { ...CONFIG, extra: 1 }, { ...CONFIG, productCostCents: { tshirts: -1 } }, { ...CONFIG, productCostCents: { tshirts: 1.5 } }, { ...CONFIG, services: { unknown: {} } },
  ]) expect((await t.call('PUT', '/pricing/draft', { config, expectedHash: null })).status, JSON.stringify(config)).toBe(400)
  expect(t.n('pricing_versions')).toBe(0)
  expect((await t.call('POST', '/pricing/simulate', { request: { lines: Array.from({ length: 11 }, () => REQUEST.lines[0]) }, config: null })).status).toBe(400)
})

test('publish is bound to the previewed draft over the routes too, and rollback adds a new version', async () => {
  const t = setup()
  const v1 = await t.publish(CONFIG, null)
  const v2 = await t.publish({ ...CONFIG, productCostCents: { tshirts: 900 } }, v1)
  const stale = await t.call('POST', '/pricing/publish', { draftId: v2, draftHash: 'a'.repeat(64), expectedActiveId: v1 })
  expect(stale.status).toBe(409)
  expect((await t.call('POST', `/pricing/versions/${v1}/restore`, { expectedHash: null })).status).toBe(200)
  const s = await t.state()
  expect(s.draft!.rollbackOf).toBe(v1)
  expect((await t.call('POST', '/pricing/publish', { draftId: s.draft!.id, draftHash: s.draft!.hash, expectedActiveId: v2 })).status).toBe(200)
  const after = await t.state()
  expect(after.active!.id).toBe(s.draft!.id)
  expect(after.versions.map((v) => v.status)).toEqual(['active', 'retired', 'retired'])
  expect(t.n("activity_log WHERE action = 'pricing_published'")).toBe(3)
  expect((await (t.sqlite.prepare("SELECT after FROM activity_log WHERE action = 'pricing_published' ORDER BY id DESC").get() as { after: string }).after)).not.toMatch(/cents/i)
})

test('discarding a draft needs its current hash and never touches published versions', async () => {
  const t = setup()
  await t.publish(CONFIG, null)
  await t.call('PUT', '/pricing/draft', { config: CONFIG, expectedHash: null })
  expect((await t.call('DELETE', '/pricing/draft', { hash: 'a'.repeat(64) })).status).toBe(409)
  const { draft } = await t.state()
  expect((await t.call('DELETE', '/pricing/draft', { hash: draft!.hash })).status).toBe(200)
  expect((await t.state()).active).not.toBeNull()
})

test('publishing pricing changes no quote or order, including accepted ones', async () => {
  const t = setup()
  const snapshot = () => JSON.stringify([t.sqlite.prepare('SELECT * FROM quotes').all(), t.sqlite.prepare('SELECT * FROM quote_items').all(), t.sqlite.prepare('SELECT * FROM order_items').all()])
  const before = snapshot()
  const v1 = await t.publish(CONFIG, null)
  await t.publish({ ...CONFIG, productCostCents: { tshirts: 999 } }, v1)
  expect(snapshot()).toBe(before)
})
