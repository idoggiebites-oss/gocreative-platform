// Minimal D1-compatible adapter over node:sqlite, because @cloudflare/vitest-pool-workers
// (0.23) only supports vitest ^4.1 and this repo runs vitest 5.
// ponytail: covers prepare/bind/first/all/run/batch only; add exec when a route needs it.
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

// schema: replaces migration 0001, for design-only DDL proofs (design/sql/*) that redefine its tables.
export function createTestD1(schema?: string) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(schema ?? readFileSync(new URL('../../migrations/0001_init.sql', import.meta.url), 'utf8'))

  const run = (sql: string, params: SQLInputValue[]) => {
    const stmt = sqlite.prepare(sql)
    if (stmt.columns().length > 0) return { results: stmt.all(...params), success: true, meta: { changes: 0, last_row_id: 0 } }
    const r = stmt.run(...params)
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
  }

  type Stmt = { sql: string; params: SQLInputValue[]; [k: string]: unknown }
  const statement = (sql: string, params: SQLInputValue[] = []): Stmt => ({
    sql,
    params,
    bind: (...values: SQLInputValue[]) => statement(sql, values),
    first: async <T>(column?: string) => {
      const row = sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined
      if (!row) return null
      return (column ? row[column] : row) as T
    },
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...params) as T[], success: true, meta: {} }),
    run: async () => run(sql, params),
  })

  // One transaction; any failure rolls every statement back, like D1.
  const batch = async (stmts: Stmt[]) => {
    sqlite.exec('BEGIN')
    try {
      const out = stmts.map((s) => run(s.sql, s.params))
      sqlite.exec('COMMIT')
      return out
    } catch (e) {
      sqlite.exec('ROLLBACK')
      throw e
    }
  }

  // Cast: the real D1Database type comes from workers-types, which this node-typed test project doesn't load.
  return { db: { prepare: (sql: string) => statement(sql), batch } as unknown as Env['DB'], sqlite }
}
