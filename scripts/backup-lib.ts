// What scripts/backup.ts and scripts/restore.ts share. Plan and reasoning: notes/backup-restore.md.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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

export type JournalEntry = { kind: 'inquiry'; inquiryId: number; submissionId: string | null; at: string; reason: string; files: { fileId: number | null; r2Key: string; sha256: string | null }[] }

/**
 * Re-applies deletions made after a backup was taken, so restoring an older database can't bring deleted requests back.
 * Runs in the isolated target with its triggers off, like the load, and restores them after. A converted inquiry is never
 * journaled, so the only rows touched are ones already deleted from live.
 */
export function replaySql(entries: JournalEntry[], triggers: { name: string; sql: string }[]): string {
  if (entries.length === 0) return ''
  const lines = ['PRAGMA defer_foreign_keys = ON;']
  for (const t of triggers) lines.push(`DROP TRIGGER ${id(t.name)};`)
  for (const e of entries) {
    lines.push(`DELETE FROM "inquiry_files" WHERE inquiry_id = ${sqlValue(e.inquiryId)}${e.submissionId ? ` OR submission_id = ${sqlValue(e.submissionId)}` : ''};`)
    for (const f of e.files) if (f.fileId !== null) lines.push(`DELETE FROM "files" WHERE id = ${sqlValue(f.fileId)} AND r2_key = ${sqlValue(f.r2Key)};`)
    lines.push(`DELETE FROM "inquiries" WHERE id = ${sqlValue(e.inquiryId)} AND status <> 'converted';`)
    if (e.submissionId) lines.push(`DELETE FROM "inquiry_submissions" WHERE id = ${sqlValue(e.submissionId)};`)
  }
  for (const t of triggers) lines.push(`${t.sql.trim().replace(/;$/, '')};`)
  return lines.join('\n') + '\n'
}

const JOURNAL_PREFIX = '_journal/deletions/'

/** Copies new deletion journal entries from R2 into dir. Wrangler has no object listing, so this asks Cloudflare's API with wrangler's own login. Read-only. */
export async function mirrorJournal(dir: string, bucket: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const run = (...args: string[]) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 })
  const { token } = JSON.parse(run('auth', 'token', '--json')) as { token: string }
  const account = (JSON.parse(run('whoami', '--json')) as { accounts: { id: string }[] }).accounts[0].id
  let cursor = ''
  let copied = 0
  for (;;) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects?prefix=${encodeURIComponent(JOURNAL_PREFIX)}&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Listing the journal failed: HTTP ${res.status}`)
    const body = await res.json() as { result: { key: string }[]; result_info?: { cursor?: string; is_truncated?: boolean } }
    for (const { key } of body.result) {
      const target = join(dir, key.slice(JOURNAL_PREFIX.length))
      if (existsSync(target)) continue
      execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--file', target], { stdio: 'ignore' })
      copied++
    }
    if (!body.result_info?.is_truncated || !body.result_info.cursor) return copied
    cursor = body.result_info.cursor
  }
}

export const readJournal = (dir: string, after: string): JournalEntry[] => (existsSync(dir) ? readdirSync(dir) : [])
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as JournalEntry)
  .filter((e) => e.at > after)
  .sort((a, b) => a.at.localeCompare(b.at))
