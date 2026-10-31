/// <reference types="vitest/globals" />
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { chooseSlot } from '../../worker/domain/productionFlow.ts'
import { PRODUCTION_STATUSES } from '../../shared/enums.ts'
import { CANCEL_ORDER_SQL, START_PRODUCTION_SQL } from '../../worker/db/productionSql.ts'
import { createTestD1 } from './d1.ts'

// users and activity_log as in migration 0001 (columns only; their triggers are irrelevant here).
const BASE = `
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','staff')), active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE activity_log (id INTEGER PRIMARY KEY, actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','portal','system')),
  actor_id INTEGER REFERENCES users (id) ON DELETE RESTRICT, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
  action TEXT NOT NULL, before TEXT CHECK (before IS NULL OR json_valid(before)), after TEXT CHECK (after IS NULL OR json_valid(after)),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
`
const SLOTS = readFileSync(new URL('../../design/sql/production-slots.sql', import.meta.url), 'utf8')
const OWNER = 1, STAFF = 2, INACTIVE_OWNER = 3

let t: ReturnType<typeof createTestD1>
let db: DatabaseSync
beforeEach(() => {
  t = createTestD1(BASE + SLOTS)
  db = t.sqlite
  db.exec(`INSERT INTO users (id, email, name, role, active) VALUES (1, 'o@x', 'Owner', 'owner', 1), (2, 's@x', 'Staff', 'staff', 1), (3, 'i@x', 'Old', 'owner', 0);
    INSERT INTO orders (id, production_status) VALUES (1, 'ready'), (2, 'ready'), (3, 'ready'), (4, 'awaiting_artwork')`)
})
afterEach(() => db.close())

const row = (id: number) => db.prepare('SELECT state, production_status, production_slot, production_override_by, production_override_reason FROM orders WHERE id = ?').get(id)
const activity = () => db.prepare('SELECT actor_id, entity_id, action, after FROM activity_log ORDER BY id').all()
// The intended start: guarded UPDATE + activity insert conditional on it, in one D1 batch.
const start = (orderId: number, slot: 1 | 2, actor = STAFF, overrideBy: number | null = null, reason: string | null = null) => t.db.batch([
  t.db.prepare(START_PRODUCTION_SQL[0]).bind(slot, overrideBy, reason, orderId),
  t.db.prepare(START_PRODUCTION_SQL[1]).bind(actor, orderId),
])
const cancel = (orderId: number) => t.db.prepare(CANCEL_ORDER_SQL).bind(orderId).run()
// Direct writes that skip the domain and the start statement entirely.
const forceSlot2 = (orderId: number, by: number | null, reason: string | null) => db.prepare(
  "UPDATE orders SET production_status = 'in_production', production_slot = 2, production_override_by = ?, production_override_reason = ? WHERE id = ?").run(by, reason, orderId)

it('combines domain slot selection with the database cap and releases slots at QC', async () => {
  const first = chooseSlot({ occupied: [], override: false, role: 'staff' })
  if (!first.ok) throw new Error('Expected first slot')
  await start(1, first.slot)
  await expect(start(2, 1)).rejects.toThrow(/UNIQUE constraint failed/)
  expect(chooseSlot({ occupied: [1], override: true, role: 'staff', reason: 'rush' }).ok).toBe(false)
  const second = chooseSlot({ occupied: [1], override: true, role: 'owner', reason: 'rush' })
  if (!second.ok) throw new Error('Expected override slot')
  await start(2, second.slot, OWNER, OWNER, 'rush')
  await expect(start(3, 2, OWNER, OWNER, 'rush')).rejects.toThrow(/UNIQUE constraint failed/)
  expect(chooseSlot({ occupied: [1, 2], override: true, role: 'owner', reason: 'rush' }).ok).toBe(false)
  db.exec("UPDATE orders SET production_status='quality_control', production_slot=NULL WHERE id=1")
  const next = chooseSlot({ occupied: [2], override: false, role: 'staff' })
  if (!next.ok) throw new Error('Expected released slot')
  await start(3, next.slot)
  expect(row(2)).toMatchObject({ production_slot: 2 })
})

it('enforces status/slot checks and the complete NEXT vocabulary', () => {
  expect(() => db.exec("UPDATE orders SET production_status='in_production', production_slot=3 WHERE id=1")).toThrow(/CHECK constraint failed/)
  expect(() => db.exec("UPDATE orders SET production_status='in_production' WHERE id=1")).toThrow(/CHECK constraint failed/)
  expect(() => db.exec('UPDATE orders SET production_slot=1 WHERE id=1')).toThrow(/CHECK constraint failed/)
  expect(() => db.exec("UPDATE orders SET production_status='completed' WHERE id=1")).toThrow(/CHECK constraint failed/)
  for (const status of PRODUCTION_STATUSES) {
    db.prepare('UPDATE orders SET production_status=?, production_slot=? WHERE id=1').run(status, status === 'in_production' ? 1 : null)
  }
})

it('rejects the second transactional start after both callers read a free slot', async () => {
  // Both requests read "slot 1 free" before either writes; D1 serializes the batches.
  await start(1, 1)
  await expect(start(2, 1)).rejects.toThrow(/UNIQUE constraint failed/)
  expect(row(2)).toMatchObject({ production_status: 'ready', production_slot: null })
  expect(activity()).toEqual([{ actor_id: STAFF, entity_id: 1, action: 'production_started', after: '{"slot":1}' }])
})

it('a losing start of the same order changes nothing and logs nothing; only ready, active orders start', async () => {
  // Full readiness in SQL arrives with M1/M3; today the guard trusts the readiness-derived 'ready'.
  await start(1, 1)
  const [update, log] = await start(1, 1)
  expect([update.meta.changes, log.meta.changes]).toEqual([0, 0])
  expect(row(1)).toMatchObject({ production_status: 'in_production', production_slot: 1 })
  const [notReady] = await start(4, 1)
  expect(notReady.meta.changes).toBe(0)
  expect(row(4)).toMatchObject({ production_status: 'awaiting_artwork', production_slot: null })
  db.exec("UPDATE orders SET state='cancelled' WHERE id=3")
  db.exec("UPDATE orders SET production_status='quality_control', production_slot=NULL WHERE id=1")
  const [cancelled] = await start(3, 1)
  expect(cancelled.meta.changes).toBe(0)
  expect(activity()).toHaveLength(1)
})

it('blocks every direct-SQL route into slot 2 that is not a valid owner override', async () => {
  // Slot 1 empty: no override is possible, even for an active owner.
  expect(() => forceSlot2(1, OWNER, 'rush')).toThrow(/production_override_invalid/)
  expect(() => db.prepare("INSERT INTO orders (id, production_status, production_slot, production_override_by, production_override_reason) VALUES (9, 'in_production', 2, 1, 'rush')").run())
    .toThrow(/production_override_invalid/)
  await start(1, 1)
  expect(() => forceSlot2(2, STAFF, 'rush')).toThrow(/production_override_invalid/)
  expect(() => forceSlot2(2, INACTIVE_OWNER, 'rush')).toThrow(/production_override_invalid/)
  expect(() => forceSlot2(2, 99, 'rush')).toThrow(/production_override_invalid|FOREIGN KEY/)
  for (const reason of [null, '', '   ']) expect(() => forceSlot2(2, OWNER, reason)).toThrow(/CHECK constraint failed/)
  expect(() => forceSlot2(2, null, 'rush')).toThrow(/production_override_invalid|CHECK constraint failed/)
  // Moving the slot-1 job itself into slot 2 leaves slot 1 empty: refused.
  expect(() => db.prepare('UPDATE orders SET production_slot = 2, production_override_by = 1, production_override_reason = ? WHERE id = 1').run('rush'))
    .toThrow(/production_override_invalid/)
  // Override columns can't decorate a non-slot-2 row.
  expect(() => db.exec("UPDATE orders SET production_override_by = 1, production_override_reason = 'x' WHERE id = 1")).toThrow(/CHECK constraint failed/)
  expect(row(2)).toMatchObject({ production_status: 'ready', production_slot: null })
  expect(activity()).toHaveLength(1)
})

it('a valid owner override takes slot 2, logs exactly one audit row, and its who/why are fixed', async () => {
  await start(1, 1)
  db.exec('DELETE FROM activity_log')
  forceSlot2(2, OWNER, 'district rush')
  expect(row(2)).toMatchObject({ production_slot: 2, production_override_by: OWNER, production_override_reason: 'district rush' })
  expect(activity()).toEqual([{ actor_id: OWNER, entity_id: 2, action: 'production_override', after: '{"reason":"district rush","running_order_id":1}' }])
  expect(() => db.exec("UPDATE orders SET production_override_reason = 'edited' WHERE id = 2")).toThrow(/production_override_immutable/)
  // The start statement takes the same path: override + start rows, one of each.
  db.exec("UPDATE orders SET production_status='quality_control', production_slot=NULL, production_override_by=NULL, production_override_reason=NULL WHERE id=2")
  db.exec('DELETE FROM activity_log')
  await start(3, 2, OWNER, OWNER, 'second rush')
  expect(activity().map(a => (a as { action: string }).action).sort()).toEqual(['production_override', 'production_started'])
})

it('cancelling releases the slot of a running slot-1 or slot-2 job', async () => {
  await start(1, 1)
  await start(2, 2, OWNER, OWNER, 'rush')
  expect(() => db.exec("UPDATE orders SET state='cancelled' WHERE id=1")).toThrow(/CHECK constraint failed/)
  expect((await cancel(2)).meta.changes).toBe(1)
  expect(row(2)).toEqual({ state: 'cancelled', production_status: 'ready', production_slot: null, production_override_by: null, production_override_reason: null })
  expect((await cancel(1)).meta.changes).toBe(1)
  expect(row(1)).toMatchObject({ state: 'cancelled', production_status: 'ready', production_slot: null })
  expect((await cancel(1)).meta.changes).toBe(0)
  expect((await cancel(4)).meta.changes).toBe(1)
  expect(row(4)).toMatchObject({ state: 'cancelled', production_status: 'awaiting_artwork' })
  // Both slots are free again.
  await start(3, 1)
})
