// Minimal D1-compatible adapter over node:sqlite, because @cloudflare/vitest-pool-workers
// (0.23) only supports vitest ^4.1 and this repo runs vitest 5.
// ponytail: covers prepare/bind/first/all/run only; add batch/exec when a route needs them.
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

export function createTestD1() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../../migrations/0001_init.sql', import.meta.url), 'utf8'))

  const statement = (sql: string, params: SQLInputValue[] = []) => ({
    bind: (...values: SQLInputValue[]) => statement(sql, values),
    first: async <T>(column?: string) => {
      const row = sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined
      if (!row) return null
      return (column ? row[column] : row) as T
    },
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...params) as T[], success: true, meta: {} }),
    run: async () => {
      const r = sqlite.prepare(sql).run(...params)
      return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
    },
  })

  // Cast: the real D1Database type comes from workers-types, which this node-typed test project doesn't load.
  return { db: { prepare: (sql: string) => statement(sql) } as unknown as Env['DB'], sqlite }
}
