// What scripts/backup.ts and scripts/restore.ts share. Plan and reasoning: notes/backup-restore.md.
import { createHash } from 'node:crypto'

export type Row = Record<string, unknown>
export type Exec = (sql: string) => Row[] | Promise<Row[]>
export type Dump = { name: string; rows: Row[] }

const PAGE = 1000
const id = (name: string) => `"${name.replaceAll('"', '""')}"`

export function sqlValue(v: unknown): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string') return `'${v.replaceAll("'", "''")}'`
  throw new Error(`Cannot restore value of type ${typeof v}: ${JSON.stringify(v)}`) // a BLOB would arrive as an array; the schema has none today
}

export const checksum = (rows: Row[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex')

export async function listTables(exec: Exec): Promise<string[]> {
  const rows = await exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' AND (name NOT LIKE 'sqlite\\_%' ESCAPE '\\' OR name = 'sqlite_sequence') ORDER BY name")
  return rows.map((r) => String(r.name))
}

async function keyColumns(exec: Exec, table: string): Promise<string[]> {
  if (table === 'sqlite_sequence') return ['name'] // the one table with no primary key
  const cols = (await exec(`PRAGMA table_info(${id(table)})`)).filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name))
  if (cols.length === 0) throw new Error(`Table ${table} has no primary key to page by`)
  return cols
}

/** All rows by keyset, never OFFSET. The maintenance flag never travels: a restored database must accept writes. */
export async function dumpTable(exec: Exec, table: string): Promise<Row[]> {
  const key = await keyColumns(exec, table)
  const cols = key.map(id).join(', ')
  const rows: Row[] = []
  for (;;) {
    const last = rows.at(-1)
    const after = last ? `WHERE (${cols}) > (${key.map((k) => sqlValue(last[k])).join(', ')})` : ''
    const page = await exec(`SELECT * FROM ${id(table)} ${after} ORDER BY ${cols} LIMIT ${PAGE}`)
    rows.push(...page)
    if (page.length < PAGE) break
  }
  return table === 'settings' ? rows.filter((r) => r.key !== 'maintenance') : rows
}

/** Parents before children. sqlite_sequence goes last: the inserts above it write to it. */
export async function foreignKeyOrder(exec: Exec, tables: string[]): Promise<string[]> {
  const parents = new Map<string, string[]>()
  for (const t of tables) parents.set(t, t === 'sqlite_sequence' ? [] : (await exec(`PRAGMA foreign_key_list(${id(t)})`)).map((f) => String(f.table)).filter((p) => p !== t))
  const order: string[] = []
  const visit = (t: string, path: string[]) => {
    if (order.includes(t)) return
    if (path.includes(t)) throw new Error(`Foreign key cycle: ${[...path, t].join(' -> ')}`)
    for (const p of parents.get(t) ?? []) visit(p, [...path, t])
    order.push(t)
  }
  for (const t of tables.filter((x) => x !== 'sqlite_sequence')) visit(t, [])
  return tables.includes('sqlite_sequence') ? [...order, 'sqlite_sequence'] : order
}

/** One script: triggers off (in this target only), rows in, the same triggers back. `tables` must be in foreign-key order. */
export function restoreSql(tables: Dump[], triggers: { name: string; sql: string }[]): string {
  const lines = ['PRAGMA defer_foreign_keys = ON;'] // self-references (and any row order within a table) check at commit
  for (const t of triggers) lines.push(`DROP TRIGGER ${id(t.name)};`)
  for (const t of [...tables].reverse()) lines.push(`DELETE FROM ${id(t.name)};`) // migrations can seed rows
  for (const t of tables) {
    for (const r of t.rows) lines.push(`INSERT INTO ${id(t.name)} (${Object.keys(r).map(id).join(', ')}) VALUES (${Object.values(r).map(sqlValue).join(', ')});`)
  }
  for (const t of triggers) lines.push(`${t.sql.trim().replace(/;$/, '')};`)
  return lines.join('\n') + '\n'
}

export type BackupInfo = { dir: string; createdAt: string; reason: 'weekly' | 'pre-migration' }

/** Backups past retention (notes/backup-restore.md, Revisions 3): the newest 8 weekly stay, pre-migration ones for 90 days. */
export function expiredBackups(backups: BackupInfo[], now: Date): BackupInfo[] {
  const cutoff = now.getTime() - 90 * 86_400_000
  const keepWeekly = new Set(backups.filter((b) => b.reason === 'weekly').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8))
  return backups.filter((b) => (b.reason === 'weekly' ? !keepWeekly.has(b) : Date.parse(b.createdAt) < cutoff))
}
