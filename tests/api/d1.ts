// Minimal D1-compatible adapter over node:sqlite, because @cloudflare/vitest-pool-workers
// (0.23) only supports vitest ^4.1 and this repo runs vitest 5.
// ponytail: covers prepare/bind/first/all/run/batch only; add exec when a route needs it.
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

const MIGRATIONS = new URL('../../migrations/', import.meta.url)
/** The migration files in apply order (what wrangler d1 migrations apply runs). */
export const migrations = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, MIGRATIONS), 'utf8'))
/** Applies one migration the way D1 does: inside one transaction, so defer_foreign_keys checks at commit. */
export function applyMigration(sqlite: DatabaseSync, sql: string) {
  sqlite.exec('BEGIN')
  try {
    sqlite.exec(sql)
    sqlite.exec('COMMIT')
  } catch (e) {
    sqlite.exec('ROLLBACK')
    throw e
  }
}

// schema: replaces the migrations, for design-only DDL proofs (design/sql/*) that redefine their tables.
// node:sqlite enforces foreign keys by default, like D1.
export function createTestD1(schema?: string) {
  const sqlite = new DatabaseSync(':memory:')
  if (schema !== undefined) sqlite.exec(schema)
  else for (const sql of migrations()) applyMigration(sqlite, sql)

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
