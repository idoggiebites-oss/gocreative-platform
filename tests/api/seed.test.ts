import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { PREP_STATUSES, PRODUCTION_STATUSES, QUOTE_STATUSES } from '../../shared/enums'
import { getOrderByNumber, readinessInput } from '../../worker/db/orders'
import { readiness } from '../../worker/domain/readiness'
import { createTestD1 } from './d1'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
const LATER = ['in_production', 'quality_control', 'production_complete']

test('the seed re-runs and leaves the migrations’ triggers exactly as they were', () => {
  const { sqlite } = createTestD1()
  const triggers = () => sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()
  const before = triggers()
  sqlite.exec(seed)
  sqlite.exec(seed)
  expect(triggers()).toEqual(before)
  expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

test('every seeded production status is what readiness derives, or a later stage with every prerequisite met', async () => {
  const { db, sqlite } = createTestD1()
  sqlite.exec(seed)
  const numbers = (sqlite.prepare('SELECT number FROM orders ORDER BY id').all() as { number: string }[]).map((r) => r.number)
  for (const number of numbers) {
    const o = (await getOrderByNumber(db, number))!
    const r = readiness(await readinessInput(db, o))
    if (LATER.includes(o.production_status)) expect(r.preProductionStatus, number).toBe('ready')
    else expect(o.production_status, number).toBe(r.preProductionStatus)
  }
})

test('the seed covers the vocabulary the screens and the gate need', () => {
  const { sqlite } = createTestD1()
  sqlite.exec(seed)
  const col = (sql: string) => (sqlite.prepare(sql).all() as { v: unknown }[]).map((r) => r.v)
  expect(col('SELECT DISTINCT production_status AS v FROM orders').sort()).toEqual([...PRODUCTION_STATUSES].sort())
  expect(col('SELECT DISTINCT status AS v FROM quotes').sort()).toEqual([...QUOTE_STATUSES].sort())
  expect(col('SELECT DISTINCT prep_status AS v FROM orders').sort()).toEqual([...PREP_STATUSES].sort())
  expect(col('SELECT DISTINCT state AS v FROM orders').sort()).toEqual(['active', 'cancelled', 'closed'])
  // An accepted quote whose order items changed after acceptance.
  expect(col(`SELECT o.number AS v FROM orders o JOIN quotes q ON q.order_id = o.id WHERE q.status = 'accepted' AND q.items_revision <> o.items_revision`)).toEqual(['2026-0014'])
  expect(col('SELECT COUNT(*) AS v FROM orders WHERE artwork_required = 0')[0]).toBeGreaterThan(0)
  expect(col('SELECT COUNT(*) AS v FROM orders WHERE materials_required = 0')[0]).toBeGreaterThan(0)
  expect(col(`SELECT COUNT(*) AS v FROM orders WHERE po_required = 0 AND authorized_at IS NOT NULL AND authorization_method IS NOT NULL AND authorization_notes IS NOT NULL`)[0]).toBeGreaterThan(0)
  expect(col(`SELECT COUNT(DISTINCT kind) AS v FROM quote_items`)[0]).toBe(3)
  expect(col(`SELECT next AS v FROM counters WHERE name = 'order' AND year = CAST(strftime('%Y','now') AS INTEGER)`)).toHaveLength(1)
})
