// Shared setup for the M5 tests (pickups.test.ts, payments.test.ts): the seeded D1 behind the real /api/app routes.
// Seed: 2026-0020 (pay at pickup) finished and notified, 50,000 of 230,300 paid; 2026-0006 (district, 72,000) picked up
// unpaid with check 2 ready for collection; 2026-0019 (pay at pickup, 156,600) and 2026-0004 (district, 73,000) in
// quality_control; 2026-0005 (district) ready; 2026-0015 closed with a voided payment.
import { readFileSync } from 'node:fs'
import { expect } from 'vitest'
import { Hono } from 'hono'
import { appRoutes } from '../../worker/routes/app'
import type { AppEnv } from '../../worker/auth'
import type { ApiError, OrderWriteResponse } from '../../shared/api'
import { createTestD1 } from './d1'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
export const OWNER = 'owner1@example.com', STAFF = 'staff@example.com'

export function setup() {
  const { db, sqlite } = createTestD1()
  sqlite.exec(seed)
  sqlite.exec(`INSERT INTO users (id, email, name, role, active) VALUES (3, '${STAFF}', 'Staff', 'staff', 1)`)
  const app = new Hono<AppEnv>().route('/api/app', appRoutes())
  const call = async <T = OrderWriteResponse>(method: string, path: string, body?: unknown, email = OWNER) => {
    const res = await app.request(`http://localhost/api/app${path}`,
      { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: db, DEV_AUTH_EMAIL: email })
    return { status: res.status, body: (await res.json()) as T & Partial<ApiError> }
  }
  const one = <T>(sql: string, ...p: (string | number)[]) => sqlite.prepare(sql).get(...p) as T
  const all = <T>(sql: string, ...p: (string | number)[]) => sqlite.prepare(sql).all(...p) as T[]
  const o = (n: string) => one<{ id: number; version: number; state: string; production_status: string }>('SELECT id, version, state, production_status FROM orders WHERE number = ?', n)
  /** Every row a refused write must leave alone. */
  const footprint = () => ({
    orders: all('SELECT * FROM orders ORDER BY id'), pickups: all('SELECT * FROM pickups ORDER BY id'),
    payments: all('SELECT * FROM payments ORDER BY id'), checks: all('SELECT * FROM check_collections ORDER BY id'),
    activity: one<{ n: number }>('SELECT COUNT(*) AS n FROM activity_log').n,
  })
  const acts = (n: string, action?: string) => all<{ actor_id: number; action: string; before: string | null; after: string | null }>(
    `SELECT actor_id, action, before, after FROM activity_log WHERE entity_type = 'order' AND entity_id = ? ${action ? 'AND action = ?' : ''} ORDER BY id`,
    o(n).id, ...(action ? [action] : []))
  const pickup = (n: string) => one<Record<string, unknown> | undefined>('SELECT * FROM pickups WHERE order_id = ?', o(n).id)
  const notify = (n: string, extra: object = {}, email = OWNER) => call('POST', `/orders/${n}/pickup/notify`, { method: 'phone', expectedVersion: o(n).version, ...extra }, email)
  const collect = (n: string, extra: object = {}, email = OWNER) =>
    call('POST', `/orders/${n}/pickup/collect`, { collectedByName: 'Jo Customer', expectedVersion: o(n).version, ...extra }, email)
  const pay = (n: string, amountCents: number, extra: object = {}, email = OWNER) =>
    call('POST', `/orders/${n}/payments`, { amountCents, method: 'cash', requestId: crypto.randomUUID(), expectedVersion: o(n).version, ...extra }, email)
  /** Finish a quality_control order through the one production write. */
  const finish = async (n: string) => expect((await call('PATCH', `/orders/${n}/production`, { to: 'production_complete', expectedVersion: o(n).version })).status).toBe(200)
  return { db, sqlite, call, one, all, o, footprint, acts, pickup, notify, collect, pay, finish }
}
