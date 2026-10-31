/// <reference types="vitest/globals" />
/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { chooseSlot } from '../../worker/domain/productionFlow.ts'
import { PRODUCTION_STATUSES_NEXT } from '../../shared/enums-next.ts'

let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../../design/sql/production-slots.sql', import.meta.url), 'utf8'))
  db.exec("INSERT INTO orders (id, production_status) VALUES (1, 'ready'), (2, 'ready'), (3, 'ready')")
})
afterEach(() => db.close())
const startSql = "UPDATE orders SET production_status='in_production', production_slot=? WHERE id=? AND production_slot IS NULL"
it('combines domain slot selection with the database cap and releases slots at QC', () => {
  const first = chooseSlot({ occupied: [], override: false, role: 'staff' })
  expect(first.ok).toBe(true)
  if (!first.ok) throw new Error('Expected first slot')
  db.prepare(startSql).run(first.slot, 1)
  expect(() => db.prepare(startSql).run(1, 2)).toThrow(/UNIQUE constraint failed/)
  expect(chooseSlot({ occupied: [1], override: true, role: 'staff', reason: 'rush' }).ok).toBe(false)
  const second = chooseSlot({ occupied: [1], override: true, role: 'owner', reason: 'rush' })
  if (!second.ok) throw new Error('Expected override slot')
  db.prepare(startSql).run(second.slot, 2)
  expect(() => db.prepare(startSql).run(2, 3)).toThrow(/UNIQUE constraint failed/)
  expect(chooseSlot({ occupied: [1, 2], override: true, role: 'owner', reason: 'rush' }).ok).toBe(false)
  db.exec("UPDATE orders SET production_status='quality_control', production_slot=NULL WHERE id=1")
  const next = chooseSlot({ occupied: [2], override: false, role: 'staff' })
  if (!next.ok) throw new Error('Expected released slot')
  db.prepare(startSql).run(next.slot, 3)
  expect(db.prepare('SELECT production_slot FROM orders WHERE id=2').get()).toEqual({ production_slot: 2 })
})
it('enforces status/slot checks and the complete NEXT vocabulary', () => {
  expect(() => db.prepare(startSql).run(3, 1)).toThrow(/CHECK constraint failed/)
  expect(() => db.exec("UPDATE orders SET production_status='in_production' WHERE id=1")).toThrow(/CHECK constraint failed/)
  expect(() => db.exec('UPDATE orders SET production_slot=1 WHERE id=1')).toThrow(/CHECK constraint failed/)
  expect(() => db.exec("UPDATE orders SET production_status='completed' WHERE id=1")).toThrow(/CHECK constraint failed/)
  for (const status of PRODUCTION_STATUSES_NEXT) {
    db.prepare('UPDATE orders SET production_status=?, production_slot=? WHERE id=1').run(status, status === 'in_production' ? 1 : null)
  }
})
it('rejects the second transactional start after both callers read a free slot', () => {
  // Model stale request reads before either write batch; SQLite serializes writers.
  const readSlots = () => db.prepare('SELECT production_slot FROM orders WHERE production_slot IS NOT NULL').all()
  db.exec('BEGIN')
  expect(readSlots()).toEqual([])
  db.exec('COMMIT')
  db.exec('BEGIN')
  expect(readSlots()).toEqual([])
  db.exec('COMMIT')
  const update = db.prepare("UPDATE orders SET production_status='in_production', production_slot=1 WHERE id=? AND production_slot IS NULL")
  db.exec('BEGIN')
  update.run(1)
  db.exec('COMMIT')
  db.exec('BEGIN')
  expect(() => update.run(2)).toThrow(/UNIQUE constraint failed/)
  db.exec('ROLLBACK')
  expect(db.prepare('SELECT production_status, production_slot FROM orders WHERE id=2').get()).toEqual({ production_status: 'ready', production_slot: null })
})
