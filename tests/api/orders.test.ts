import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { Hono } from 'hono'
import { appRoutes } from '../../worker/routes/app'
import type { AppEnv } from '../../worker/auth'
import type { DashboardResponse, OrderDetailResponse, OrdersListResponse } from '../../shared/api'
import { createTestD1 } from './d1'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')

// A fresh seeded database per test, authenticated through the localhost DEV_AUTH_EMAIL bypass.
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
  const prod = (n: string) => one<{ production_status: string; state: string }>('SELECT production_status, state FROM orders WHERE number = ?', n)
  const activityCount = () => one<{ n: number }>('SELECT COUNT(*) AS n FROM activity_log').n
  return { sqlite, call, json, one, prod, activityCount }
}

describe('auth', () => {
  test('401 without auth on every endpoint', async () => {
    const t = setup()
    for (const [method, path] of [
      ['GET', '/dashboard'],
      ['GET', '/orders'],
      ['GET', '/orders/2026-0001'],
      ['PATCH', '/orders/2026-0005/production'],
      ['PATCH', '/orders/2026-0011/purchase-orders/12'],
    ]) {
      const res = await t.call(method!, path!, method === 'GET' ? undefined : { to: 'completed' }, false)
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })
})

describe('dashboard', () => {
  test('metrics match direct SQL', async () => {
    const t = setup()
    const d = await t.json<DashboardResponse>(await t.call('GET', '/dashboard'))
    const n = (sql: string) => t.one<{ n: number }>(sql).n
    expect(d.metrics.activeOrders).toBe(n(`SELECT COUNT(*) AS n FROM orders WHERE state = 'active'`))
    expect(d.metrics.posAwaitingApproval.count).toBe(
      n(`SELECT COUNT(*) AS n FROM orders o WHERE state = 'active' AND (SELECT status FROM purchase_orders p WHERE p.order_id = o.id ORDER BY id DESC LIMIT 1) IN ('received','under_review')`),
    )
    expect(d.metrics.posAwaitingApproval.amountCents).toBe(72000 + 186000)
    expect(d.metrics.dueIn7Days.overdue).toBe(
      n(`SELECT COUNT(*) AS n FROM orders WHERE state = 'active' AND production_status <> 'completed' AND due_date < date('now')`),
    )
    expect(d.metrics.inProduction.count).toBe(n(`SELECT COUNT(*) AS n FROM orders WHERE state='active' AND production_status IN ('in_production','quality_control')`))
    expect(d.needsAttention.length).toBeLessThanOrEqual(10)
    expect(d.needsAttention[0]?.reason).toBe('overdue')
    expect(d.recentActivity).toHaveLength(10)
    for (const a of d.recentActivity) expect(Object.keys(a).sort()).toEqual(['action', 'actor', 'createdAt', 'entityId', 'entityType', 'orderNumber'])
  })
})

describe('orders list', () => {
  test('each view returns only matching rows and counts agree', async () => {
    const t = setup()
    const get = async (q: string) => t.json<OrdersListResponse>(await t.call('GET', `/orders?${q}`))
    const rowsOf = async (view: string) => ((await get(`view=${view}&limit=200`)).rows as { number: string }[]).map((r) => r.number)
    const sqlNums = (where: string) => (t.sqlite.prepare(`SELECT number FROM orders o WHERE ${where} ORDER BY due_date, number`).all() as { number: string }[]).map((r) => r.number)
    expect(await rowsOf('active')).toEqual(sqlNums(`state='active'`))
    expect(await rowsOf('completed')).toEqual(sqlNums(`state='completed'`))
    expect(await rowsOf('ready')).toEqual(sqlNums(`production_status='ready_for_pickup'`))
    expect(await rowsOf('in_production')).toEqual(sqlNums(`production_status IN ('in_production','quality_control')`))
    expect(await rowsOf('waiting_artwork')).toEqual(sqlNums(`state='active' AND artwork_status <> 'approved'`))
    expect(await rowsOf('waiting_po')).toEqual(
      sqlNums(`state='active' AND po_required=1 AND COALESCE((SELECT status FROM purchase_orders p WHERE p.order_id=o.id ORDER BY id DESC LIMIT 1),'') <> 'approved'`),
    )
    const active = await get('view=active')
    expect(active.counts.active).toBe((await rowsOf('active')).length)
    expect(active.counts.completed).toBe(2 + 1) // orders 1, 2, 15
    const row = (active.rows as { number: string; methods: string[]; totalQty: number; latestPoStatus: string | null }[]).find((r) => r.number === '2026-0004')
    expect(row).toMatchObject({ methods: ['screen', 'laser_cut'], totalQty: 50, latestPoStatus: 'approved' })
  })
  test('inquiries view reads the inquiries table', async () => {
    const t = setup()
    t.sqlite.exec(`INSERT INTO inquiries (payload, contact_name, status) VALUES ('{}', 'Pat', 'new'), ('{}', 'Spam', 'spam')`)
    const res = await t.json<OrdersListResponse>(await t.call('GET', '/orders?view=inquiries'))
    expect(res.view).toBe('inquiries')
    expect(res.rows).toHaveLength(1)
    expect(res.counts.inquiries).toBe(1)
  })
  test('q by PO number, customer name and number prefix', async () => {
    const t = setup()
    const nums = async (q: string) => (await t.json<OrdersListResponse>(await t.call('GET', `/orders?q=${encodeURIComponent(q)}`))).rows.map((r) => ('number' in r ? r.number : ''))
    expect(await nums('po-2026-120')).toEqual(['2026-0012'])
    expect(await nums('cedar hollow')).toContain('2026-0003')
    expect(await nums('2026-0005')).toEqual(['2026-0005'])
  })
  test('injection-looking q returns nothing and no error', async () => {
    const t = setup()
    const res = await t.call('GET', `/orders?q=${encodeURIComponent(`' OR 1=1 --`)}`)
    expect(res.status).toBe(200)
    expect((await t.json<OrdersListResponse>(res)).rows).toEqual([])
  })
  test('bad view and oversized limit are 400', async () => {
    const t = setup()
    expect((await t.call('GET', '/orders?view=nope')).status).toBe(400)
    expect((await t.call('GET', '/orders?limit=201')).status).toBe(400)
  })
})

describe('order detail', () => {
  test('404 unknown, 400 malformed', async () => {
    const t = setup()
    expect((await t.call('GET', '/orders/2026-9999')).status).toBe(404)
    expect((await t.call('GET', '/orders/abc')).status).toBe(400)
  })
  test('sizes parsed, gate present, notes without author email', async () => {
    const t = setup()
    const d = await t.json<OrderDetailResponse>(await t.call('GET', '/orders/2026-0001'))
    expect(d.items[0]?.sizes).toEqual({ M: 20, L: 24, XL: 10 })
    expect(d.items[1]?.sizes).toBeNull()
    expect(d.gate).toHaveProperty('ok')
    expect(d.purchaseOrders[0]?.poNumber).toBe('PO-2026-10')
    const n = await t.json<OrderDetailResponse>(await t.call('GET', '/orders/2026-0003'))
    expect(n.notes[0]).toEqual({ id: 1, body: 'Customer prefers pickup after 3pm.', authorName: 'Owner Two', createdAt: expect.any(String) })
    expect(JSON.stringify(n.notes)).not.toContain('@')
    expect(n.activity.length).toBeGreaterThan(0)
  })
})

describe('production status change', () => {
  const patch = (t: ReturnType<typeof setup>, n: string, to: string) => t.call('PATCH', `/orders/${n}/production`, { to })

  test('PO under review blocks ready: 409, row unchanged, nothing logged', async () => {
    const t = setup()
    t.sqlite.exec(`UPDATE purchase_orders SET status = 'under_review' WHERE id = 12`) // order 11: artwork approved, awaiting_authorization
    const before = t.activityCount()
    const res = await patch(t, '2026-0011', 'ready')
    expect(res.status).toBe(409)
    expect(await t.json<{ reasons: string[] }>(res)).toMatchObject({ reasons: ['po_not_approved'] })
    expect(t.prod('2026-0011').production_status).toBe('awaiting_authorization')
    expect(t.activityCount()).toBe(before)
  })
  test('valid one-step move logs exactly one activity row', async () => {
    const t = setup()
    const before = t.activityCount()
    const res = await patch(t, '2026-0005', 'in_production')
    expect(res.status).toBe(200)
    expect(t.prod('2026-0005').production_status).toBe('in_production')
    expect(t.activityCount()).toBe(before + 1)
    expect(t.one<{ actor_id: number; action: string; before: string; after: string }>('SELECT * FROM activity_log ORDER BY id DESC LIMIT 1')).toMatchObject({
      actor_id: 1, action: 'production_status_changed', before: '{"production_status":"ready"}',
    })
  })
  test('skipping a stage is 409', async () => {
    const t = setup()
    expect((await patch(t, '2026-0005', 'quality_control')).status).toBe(409)
    expect(t.prod('2026-0005').production_status).toBe('ready')
  })
  test('ready_for_pickup to completed sets state completed', async () => {
    const t = setup()
    expect((await patch(t, '2026-0006', 'completed')).status).toBe(200)
    expect(t.prod('2026-0006')).toEqual({ production_status: 'completed', state: 'completed' })
  })
  test('unknown order 404, bad body 400', async () => {
    const t = setup()
    expect((await patch(t, '2026-9999', 'ready')).status).toBe(404)
    expect((await patch(t, '2026-0005', 'nonsense')).status).toBe(400)
  })
  test('batch atomicity: a failing activity insert rolls the status back', async () => {
    const t = setup()
    t.sqlite.exec('DROP TABLE activity_log')
    const res = await patch(t, '2026-0005', 'in_production')
    expect(res.status).toBe(500)
    expect(t.prod('2026-0005').production_status).toBe('ready')
  })
})

describe('purchase order status change', () => {
  const patch = (t: ReturnType<typeof setup>, n: string, po: number, to: string) => t.call('PATCH', `/orders/${n}/purchase-orders/${po}`, { to })

  test('approving moves awaiting_authorization to ready when artwork is approved', async () => {
    const t = setup()
    t.sqlite.exec(`UPDATE purchase_orders SET status = 'under_review' WHERE id = 12`)
    const before = t.activityCount()
    const res = await patch(t, '2026-0011', 12, 'approved')
    expect(res.status).toBe(200)
    expect(await t.json(res)).toEqual({ poId: 12, status: 'approved', productionStatus: 'ready' })
    expect(t.prod('2026-0011').production_status).toBe('ready')
    expect(t.activityCount()).toBe(before + 1)
    expect(t.one<{ after: string }>('SELECT after FROM activity_log ORDER BY id DESC LIMIT 1').after).toBe('{"po_id":12,"po_status":"approved","production_status":"ready"}')
  })
  test('approving with pending artwork moves to awaiting_artwork', async () => {
    const t = setup()
    expect((await patch(t, '2026-0012', 13, 'approved')).status).toBe(200) // order 12: artwork pending
    expect(t.prod('2026-0012').production_status).toBe('awaiting_artwork')
  })
  test('revoking approval does not move an order already at ready', async () => {
    const t = setup()
    expect((await patch(t, '2026-0005', 6, 'rejected')).status).toBe(200)
    expect(t.prod('2026-0005').production_status).toBe('ready')
    const d = await t.json<OrderDetailResponse>(await t.call('GET', '/orders/2026-0005'))
    expect(d.gate).toEqual({ ok: false, reasons: ['po_not_approved'] })
  })
  test('invalid transition is 409 and changes nothing', async () => {
    const t = setup()
    const before = t.activityCount()
    expect((await patch(t, '2026-0011', 12, 'approved')).status).toBe(409) // received -> approved
    expect(t.activityCount()).toBe(before)
  })
  test("another order's PO is 404", async () => {
    const t = setup()
    t.sqlite.exec(`UPDATE purchase_orders SET status = 'under_review' WHERE id = 12`)
    expect((await patch(t, '2026-0012', 12, 'approved')).status).toBe(404)
    expect((await patch(t, '2026-0011', 999, 'approved')).status).toBe(404)
  })
  test('batch atomicity: a failing activity insert rolls the PO and order back', async () => {
    const t = setup()
    t.sqlite.exec(`UPDATE purchase_orders SET status = 'under_review' WHERE id = 12`)
    t.sqlite.exec('DROP TABLE activity_log')
    expect((await patch(t, '2026-0011', 12, 'approved')).status).toBe(500)
    expect(t.one<{ status: string }>('SELECT status FROM purchase_orders WHERE id = 12').status).toBe('under_review')
    expect(t.prod('2026-0011').production_status).toBe('awaiting_authorization')
  })
})
