/// <reference types="vitest/globals" />
/// <reference types="node" />
// The §4.3 slot rules as the database enforces them, on the real migration chain (0001–0005) and the seed: every
// direct-SQL route around the app, the slot-2 override and its audit row, the migration's handling of existing rows,
// and the one writer (applyProductionChange) under a race. The routes are tested in production.test.ts.
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { PRODUCTION_STATUSES } from '../../shared/enums.ts'
import { applyProductionChange } from '../../worker/db/orders.ts'
import { applyMigration, createTestD1, migrations } from './d1.ts'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
const OWNER = 1, STAFF = 3, INACTIVE_OWNER = 4
// Seed: order 3 runs in slot 1; 5 and 17 are ready; 4 and 19 in quality_control; 24 cancelled; 1 closed.

let t: ReturnType<typeof createTestD1>
let db: DatabaseSync
beforeEach(() => {
  t = createTestD1()
  db = t.sqlite
  db.exec(seed)
  db.exec(`INSERT INTO users (id, email, name, role, active) VALUES (3, 'staff@example.com', 'Staff', 'staff', 1), (4, 'old@example.com', 'Old', 'owner', 0)`)
})
afterEach(() => db.close())

const row = (id: number) => db.prepare('SELECT state, production_status, production_slot, production_override_by, production_override_reason FROM orders WHERE id = ?').get(id)
const activityCount = () => (db.prepare('SELECT COUNT(*) AS n FROM activity_log').get() as { n: number }).n
const overrides = () => db.prepare(`SELECT actor_id, entity_id, after FROM activity_log WHERE action = 'production_override' ORDER BY id`).all()
const exec = (sql: string, ...p: (string | number | null)[]) => () => db.prepare(sql).run(...p)
// A direct write into slot 2 that skips the domain and the writer entirely.
const forceSlot2 = (orderId: number, by: number | null, reason: string | null) =>
  exec(`UPDATE orders SET production_status = 'in_production', production_slot = 2, production_override_by = ?, production_override_reason = ? WHERE id = ?`, by, reason, orderId)()
const version = (id: number) => (db.prepare('SELECT version FROM orders WHERE id = ?').get(id) as { version: number }).version
const start = (orderId: number, slot: 1 | 2, overrideBy: number | null = null, reason: string | null = null) =>
  applyProductionChange(t.db, { orderId, actorId: overrideBy ?? OWNER, from: 'ready', to: 'in_production', expectedVersion: version(orderId), slot: { slot, overrideBy, reason } })

describe('slot exactly while in_production, only on active orders', () => {
  it('refuses a slot without in_production, in_production without a slot, and a slot outside 1–2', () => {
    expect(exec(`UPDATE orders SET production_slot = 2 WHERE id = 5`)).toThrow(/production_slot_invalid|production_override_invalid/)
    expect(exec(`UPDATE orders SET production_slot = NULL WHERE id = 3`)).toThrow(/production_slot_invalid/)
    expect(exec(`UPDATE orders SET production_status = 'quality_control' WHERE id = 3`)).toThrow(/production_slot_invalid/)
    expect(exec(`UPDATE orders SET production_status = 'in_production' WHERE id = 5`)).toThrow(/production_slot_invalid/)
    expect(exec(`UPDATE orders SET production_slot = 3 WHERE id = 3`)).toThrow(/CHECK constraint failed/)
    expect(exec(`INSERT INTO orders (number, customer_id, source, title, production_status) VALUES ('2026-0900', 1, 'phone', 'x', 'in_production')`)).toThrow(/production_slot_invalid/)
    expect(exec(`INSERT INTO orders (number, customer_id, source, title, production_status, production_slot) VALUES ('2026-0901', 1, 'phone', 'x', 'ready', 2)`)).toThrow(/production_slot_invalid|production_override_invalid/)
    expect(row(3)).toMatchObject({ production_status: 'in_production', production_slot: 1 })
  })

  it('a cancelled or closed order cannot hold a slot, by any column or rowid alias', () => {
    for (const sql of [`UPDATE orders SET state = 'cancelled' WHERE id = 3`, `UPDATE orders SET state = 'closed' WHERE rowid = 3`,
      `UPDATE orders SET oid = oid, state = 'cancelled' WHERE id = 3`, `UPDATE orders SET _rowid_ = 3, state = 'cancelled' WHERE _rowid_ = 3`]) {
      expect(exec(sql), sql).toThrow(/production_slot_invalid/)
    }
    // Starting a cancelled order by hand: refused even with slot 1 free.
    db.exec(`UPDATE orders SET production_status = 'quality_control', production_slot = NULL WHERE id = 3`)
    expect(exec(`UPDATE orders SET production_status = 'in_production', production_slot = 1 WHERE id = 24`)).toThrow(/production_slot_invalid/)
    expect(row(24)).toMatchObject({ state: 'cancelled', production_slot: null })
  })

  it('at most one job per slot: a second slot-1 job hits one_job_per_slot', () => {
    expect(exec(`UPDATE orders SET production_status = 'in_production', production_slot = 1 WHERE id = 5`)).toThrow(/production_slot_invalid/) // the slot trigger refuses before the unique index (which still backs it)
  })

  it('every status is reachable with the right slot (the CHECK vocabulary is complete)', () => {
    db.exec(`UPDATE orders SET production_status = 'quality_control', production_slot = NULL WHERE id = 3`)
    for (const status of PRODUCTION_STATUSES) db.prepare('UPDATE orders SET production_status = ?, production_slot = ? WHERE id = 5').run(status, status === 'in_production' ? 1 : null)
    expect(exec(`UPDATE orders SET production_status = 'completed' WHERE id = 5`)).toThrow(/CHECK constraint failed/)
  })
})

describe('slot 2: the owner override', () => {
  it('blocks every direct-SQL route into slot 2 that is not a valid owner override', () => {
    expect(() => forceSlot2(5, STAFF, 'rush')).toThrow(/production_override_invalid/)
    expect(() => forceSlot2(5, INACTIVE_OWNER, 'rush')).toThrow(/production_override_invalid/)
    expect(() => forceSlot2(5, 99, 'rush')).toThrow(/production_override_invalid|FOREIGN KEY/)
    for (const reason of [null, '', '   ']) expect(() => forceSlot2(5, OWNER, reason)).toThrow(/production_override_invalid/)
    expect(() => forceSlot2(5, null, 'rush')).toThrow(/production_override_invalid/)
    // The slot-1 job can't move itself into slot 2: that leaves slot 1 empty.
    expect(exec(`UPDATE orders SET production_slot = 2, production_override_by = 1, production_override_reason = 'rush' WHERE id = 3`)).toThrow(/production_override_invalid/)
    // Override columns can't decorate a job that isn't in slot 2, nor a waiting one.
    expect(exec(`UPDATE orders SET production_override_by = 1, production_override_reason = 'x' WHERE id = 3`)).toThrow(/production_slot_invalid/)
    expect(exec(`UPDATE orders SET production_override_reason = 'x' WHERE id = 5`)).toThrow(/production_slot_invalid/)
    // Slot 1 empty: no override is possible, even for an active owner, by UPDATE or INSERT.
    db.exec(`UPDATE orders SET production_status = 'quality_control', production_slot = NULL WHERE id = 3`)
    expect(() => forceSlot2(5, OWNER, 'rush')).toThrow(/production_override_invalid/)
    expect(exec(`INSERT INTO orders (number, customer_id, source, title, production_status, production_slot, production_override_by, production_override_reason)
      VALUES ('2026-0902', 1, 'phone', 'x', 'in_production', 2, 1, 'rush')`)).toThrow(/production_override_invalid/)
    expect(row(5)).toMatchObject({ production_status: 'ready', production_slot: null })
    expect(overrides()).toEqual([])
  })

  it('a valid override takes slot 2 with exactly one audit row; who and why are fixed; it never moves into slot 1', () => {
    forceSlot2(5, OWNER, 'district rush')
    expect(row(5)).toMatchObject({ production_slot: 2, production_override_by: OWNER, production_override_reason: 'district rush' })
    expect(overrides()).toEqual([{ actor_id: OWNER, entity_id: 5, after: '{"reason":"district rush","running_order_id":3}' }])
    expect(exec(`UPDATE orders SET production_override_reason = 'edited' WHERE id = 5`)).toThrow(/production_override_immutable/)
    expect(exec(`UPDATE orders SET production_override_by = 2 WHERE id = 5`)).toThrow(/production_override_immutable/)
    // Slot 1 frees up; the slot-2 job stays where it is.
    db.exec(`UPDATE orders SET production_status = 'quality_control', production_slot = NULL WHERE id = 3`)
    expect(exec(`UPDATE orders SET production_slot = 1, production_override_by = NULL, production_override_reason = NULL WHERE id = 5`)).toThrow(/production_slot_invalid/)
    expect(row(5)).toMatchObject({ production_slot: 2 })
    // Leaving production clears the override with the slot.
    db.exec(`UPDATE orders SET production_status = 'quality_control', production_slot = NULL, production_override_by = NULL, production_override_reason = NULL WHERE id = 5`)
    expect(row(5)).toMatchObject({ production_slot: null, production_override_by: null, production_override_reason: null })
    expect(overrides()).toHaveLength(1)
  })
})

describe('REPLACE and identity changes can\'t get around the slot rules (Codex review of fcdbb90)', () => {
  // Order 3 runs in slot 1; force 5 into slot 2 with an override, then free slot 1.
  const setupSlot2 = () => {
    forceSlot2(5, OWNER, 'rush')
    exec(`UPDATE orders SET production_status = 'quality_control', production_slot = NULL WHERE id = 3`)()
  }
  it('INSERT OR REPLACE of a slot-2 job can\'t promote it to slot 1 or rewrite its override', () => {
    setupSlot2()
    const before = { row: row(5), audit: overrides(), n: activityCount() }
    const cols = 'id, number, customer_id, source, title, production_status, state'
    const copy = (slot: number, by: number | null, reason: string | null) => exec(`INSERT OR REPLACE INTO orders (${cols}, production_slot, production_override_by, production_override_reason)
      SELECT ${cols}, ?, ?, ? FROM orders WHERE id = 5`, slot, by, reason)
    // Whichever trigger refuses first (SQLite runs the newest first), the insert is refused and nothing changes.
    expect(copy(1, null, null)).toThrow(/order_exists|production_/)
    expect(copy(2, OWNER, 'a different reason')).toThrow(/order_exists|production_/)
    expect({ row: row(5), audit: overrides(), n: activityCount() }).toEqual(before)
  })
  it('a new row can\'t evict the job holding a slot', () => {
    expect(exec(`INSERT OR REPLACE INTO orders (number, customer_id, source, title, production_status, production_slot) SELECT 'X-1', customer_id, source, 'x', 'in_production', 1 FROM orders WHERE id = 3`)).toThrow(/production_slot_invalid/)
    expect(exec(`UPDATE OR REPLACE orders SET production_status = 'in_production', production_slot = 1 WHERE id = 5`)).toThrow(/production_slot_invalid/)
    expect(row(3)).toMatchObject({ production_status: 'in_production', production_slot: 1 })
  })
  it('an order\'s id is fixed through every alias, so it can\'t count itself as the running slot-1 job', () => {
    const n = activityCount()
    for (const alias of ['id', 'rowid', 'oid', '_rowid_']) {
      expect(exec(`UPDATE orders SET ${alias} = 999, production_slot = 2, production_override_by = ?, production_override_reason = 'rush' WHERE id = 3`, OWNER), alias).toThrow(/order_id_fixed|production_override_invalid/)
      expect(exec(`UPDATE orders SET ${alias} = 999 WHERE id = 5`), alias).toThrow(/order_id_fixed/)
    }
    // Nor its number: UPDATE OR REPLACE onto the running job's number would delete that job.
    const n3 = (db.prepare('SELECT number FROM orders WHERE id = 3').get() as { number: string }).number
    expect(exec(`UPDATE OR REPLACE orders SET number = ? WHERE id = 5`, n3)).toThrow(/order_id_fixed/)
    expect(row(3)).toMatchObject({ production_slot: 1, production_override_by: null })
    expect(activityCount()).toBe(n)
  })
})

describe('the writer under a race', () => {
  it('two starts that both read slot 1 free: one wins, the other rolls back whole and logs nothing', async () => {
    db.exec(`UPDATE orders SET production_status = 'quality_control', production_slot = NULL WHERE id = 3`)
    const before = activityCount()
    expect(await start(5, 1)).toBe(true)
    await expect(start(17, 1)).rejects.toThrow(/production_slot_invalid/) // the slot trigger refuses before the unique index (which still backs it)
    expect(row(17)).toMatchObject({ production_status: 'ready', production_slot: null })
    expect(activityCount()).toBe(before + 1)
  })
  it('an override that lost its slot-1 job meanwhile is refused by the trigger', async () => {
    db.exec(`UPDATE orders SET production_status = 'quality_control', production_slot = NULL WHERE id = 3`)
    await expect(start(5, 2, OWNER, 'rush')).rejects.toThrow(/production_override_invalid/)
    expect(row(5)).toMatchObject({ production_status: 'ready', production_slot: null })
    expect(overrides()).toEqual([])
  })
  it('a third job is refused even for an owner', async () => {
    expect(await start(5, 2, OWNER, 'rush')).toBe(true)
    await expect(start(17, 2, OWNER, 'another')).rejects.toThrow(/production_slot_invalid/) // the slot trigger refuses before the unique index (which still backs it)
    expect(overrides()).toHaveLength(1)
  })
})

describe('migration 0005 on existing rows', () => {
  const upTo4 = () => {
    const sqlite = new DatabaseSync(':memory:')
    const all = migrations()
    for (const sql of all.slice(0, 4)) applyMigration(sqlite, sql)
    sqlite.exec(`INSERT INTO users (id, email, name, role) VALUES (1, 'o@x', 'O', 'owner');
      INSERT INTO customers (id, kind, name) VALUES (1, 'individual', 'C');`)
    const order = (id: number, status: string, state = 'active') => sqlite.prepare(
      `INSERT INTO orders (id, number, customer_id, source, title, production_status, state) VALUES (?, ?, 1, 'phone', 't', ?, ?)`).run(id, `2026-${String(id).padStart(4, '0')}`, status, state)
    return { sqlite, order, m5: () => applyMigration(sqlite, all[4]!) }
  }
  it('gives the one running active order slot 1 and drops an inactive running order to ready', () => {
    const { sqlite, order, m5 } = upTo4()
    order(1, 'in_production'); order(2, 'in_production', 'cancelled'); order(3, 'quality_control')
    m5()
    expect(sqlite.prepare('SELECT id, production_status, production_slot, units_completed, queue_position FROM orders ORDER BY id').all()).toEqual([
      { id: 1, production_status: 'in_production', production_slot: 1, units_completed: 0, queue_position: null },
      { id: 2, production_status: 'ready', production_slot: null, units_completed: 0, queue_position: null },
      { id: 3, production_status: 'quality_control', production_slot: null, units_completed: 0, queue_position: null },
    ])
  })
  it('refuses to guess between two running active orders: the whole migration rolls back', () => {
    const { sqlite, order, m5 } = upTo4()
    order(1, 'in_production'); order(2, 'in_production')
    expect(m5).toThrow(/CHECK constraint failed/)
    const cols = (sqlite.prepare(`SELECT name FROM pragma_table_info('orders')`).all() as { name: string }[]).map((c) => c.name)
    expect(cols).not.toContain('production_slot')
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%m0005%'`).all()).toEqual([])
  })
})
