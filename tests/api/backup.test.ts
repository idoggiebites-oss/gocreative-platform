// The backup's two promises that can't be seen on a nearly empty live database: restore gets past every trigger with
// real historical states, and the maintenance switch stops writes without stopping reads.
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { checksum, dumpTable, expiredBackups, foreignKeyOrder, listTables, restoreSql, sqlValue, type Exec, type Row } from '../../scripts/backup-lib.ts'
import { app } from '../../worker/index'
import { createTestD1 } from './d1'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
const execOn = (sqlite: ReturnType<typeof createTestD1>['sqlite']): Exec => (sql) => sqlite.prepare(sql).all() as Row[]
const triggersOf = (exec: Exec) => exec("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name") as { name: string; sql: string }[]

async function dumped() {
  const { sqlite } = createTestD1()
  sqlite.exec(seed)
  const exec = execOn(sqlite)
  const order = await foreignKeyOrder(exec, await listTables(exec))
  const tables = await Promise.all(order.map(async (name) => ({ name, rows: await dumpTable(exec, name) })))
  return { tables, exec }
}

test('a seeded database round-trips through restoreSql exactly, triggers included', async () => {
  const { tables } = await dumped()
  expect(tables.find((t) => t.name === 'activity_log')?.rows.length).toBeGreaterThan(0)
  const target = createTestD1()
  const exec = execOn(target.sqlite)
  const triggers = triggersOf(exec)
  expect(triggers.length).toBeGreaterThan(40)
  target.sqlite.exec('BEGIN')
  target.sqlite.exec(restoreSql(tables, triggers))
  target.sqlite.exec('COMMIT')
  for (const t of tables) expect(checksum(await dumpTable(exec, t.name)), t.name).toBe(checksum(t.rows))
  expect(exec('PRAGMA foreign_key_check')).toEqual([])
  expect(triggersOf(exec)).toEqual(triggers)
  expect(() => target.sqlite.exec('DELETE FROM activity_log')).toThrow() // the guards are live again
})

test('control: the same rows do not load with the triggers left on, so dropping them is what makes restore work', async () => {
  const { tables } = await dumped()
  const target = createTestD1()
  target.sqlite.exec('BEGIN')
  expect(() => target.sqlite.exec(restoreSql(tables, []))).toThrow()
  target.sqlite.exec('ROLLBACK')
})

test('a snapshot taken under maintenance restores with writes open', async () => {
  const { sqlite } = createTestD1()
  sqlite.exec("INSERT INTO settings (key, value) VALUES ('maintenance', 'backup'), ('other', 'kept')")
  expect((await dumpTable(execOn(sqlite), 'settings')).map((r) => r.key)).toEqual(['intake_closed', 'other'])
})

test('values are quoted so text cannot break out, and anything unrestorable stops the load', () => {
  expect(sqlValue("O'Brien; DROP TABLE orders")).toBe("'O''Brien; DROP TABLE orders'")
  expect(sqlValue(null)).toBe('NULL')
  expect(sqlValue(12)).toBe('12')
  expect(() => sqlValue([1, 2])).toThrow()
})

test('retention keeps the newest 8 weekly and pre-migration backups for 90 days', () => {
  const now = new Date('2026-12-31T00:00:00Z')
  const weekly = Array.from({ length: 10 }, (_, i) => ({ dir: `w${i}`, reason: 'weekly' as const, createdAt: new Date(now.getTime() - i * 7 * 86_400_000).toISOString() }))
  const pre = [
    { dir: 'recent', reason: 'pre-migration' as const, createdAt: '2026-11-01T00:00:00Z' },
    { dir: 'old', reason: 'pre-migration' as const, createdAt: '2026-08-01T00:00:00Z' },
  ]
  expect(expiredBackups([...weekly, ...pre], now).map((b) => b.dir)).toEqual(['w8', 'w9', 'old'])
})

test('maintenance refuses every write before it runs, leaves reads alone, and lifts cleanly', async () => {
  const { db, sqlite } = createTestD1()
  sqlite.exec(seed)
  const env = { DB: db, DEV_AUTH_EMAIL: 'owner1@example.com' } as unknown as Env
  const post = () => app.request('http://localhost/api/app/customers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'During Backup', kind: 'individual' }) }, env)
  const count = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n
  const n = count()

  sqlite.exec("INSERT INTO settings (key, value) VALUES ('maintenance', 'backup')")
  const refused = await post()
  expect([refused.status, ((await refused.json()) as { code: string }).code]).toEqual([503, 'maintenance'])
  expect(count()).toBe(n)
  expect((await app.request('http://localhost/api/app/customers', {}, env)).status).toBe(200)

  sqlite.exec("DELETE FROM settings WHERE key = 'maintenance'")
  expect((await post()).status).toBe(201)
  expect(count()).toBe(n + 1)
})
