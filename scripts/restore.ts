// npm run restore -- <backup dir> [--database-id <id> --database-name <name>]: loads a backup into an isolated database and proves it matches.
// Without --database-id the target is a fresh local D1 and R2 (the drill); with it, a new empty remote D1. It refuses the live one. Runbook: notes/backup-restore.md.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { checksum, dumpTable, foreignKeyOrder, mirrorJournal, readJournal, replaySql, restoreSql, type Row } from './backup-lib.ts'

// Read, not hard-coded: after a recovery cut-over the live database is whichever one wrangler.jsonc binds.
const LIVE_ID = /"database_id":\s*"([^"]+)"/.exec(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))?.[1]
if (!LIVE_ID) throw new Error('No database_id in wrangler.jsonc')
const BUCKET = 'gocreative-files'
const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'database-id': { type: 'string' }, 'database-name': { type: 'string' }, 'accept-local-journal': { type: 'boolean' } } })
const backup = resolve(positionals[0] ?? '')
const databaseId = values['database-id']
const remote = databaseId !== undefined
if (remote && (databaseId === LIVE_ID || !values['database-name'] || values['database-name'] === 'gocreative')) throw new Error('A restore goes into a new, isolated database with its own name, never the live one')
const name = values['database-name'] ?? 'gocreative'

const manifest = JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8')) as { createdAt: string; migrations: string[]; tables: Record<string, { rows: number; sha256: string }> }
const scratch = mkdtempSync(join(tmpdir(), 'gocreative-restore-'))
const state = join(scratch, 'state')
const where = remote ? ['--remote'] : ['--local', '--persist-to', state]

const config = (migrationsDir: string) => {
  const path = join(scratch, 'wrangler.json')
  writeFileSync(path, JSON.stringify({
    name: 'gocreative-restore', compatibility_date: '2026-10-01',
    d1_databases: [{ binding: 'DB', database_name: name, database_id: databaseId ?? LIVE_ID, migrations_dir: migrationsDir }], // locally this id only names a folder in scratch
    r2_buckets: [{ binding: 'FILES', bucket_name: BUCKET }],
  }))
  return path
}
const wrangler = (...args: string[]) => execFileSync('npx', ['wrangler', ...args, '-c', join(scratch, 'wrangler.json')], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'] })
const d1 = (sql: string) => (JSON.parse(wrangler('d1', 'execute', name, ...where, '--json', '--command', sql)) as { results: Row[] }[])[0].results

// Deletions made after this backup was taken must stay deleted, so a restore needs the current journal. Without the account it stops,
// unless a person accepts the local copy knowing newer deletions may be missing (the account itself being lost is the reason to).
const journalDir = join(homedir(), 'gocreative-backups', 'journal')
try {
  await mirrorJournal(journalDir, BUCKET)
} catch (e) {
  if (!values['accept-local-journal']) throw new Error(`Could not refresh the deletion journal (${String(e)}). A restore could bring deleted requests back. Fix access, or rerun with --accept-local-journal to use the local copy of ${readJournal(journalDir, '').length} entries.`)
  console.warn('!! Using the local deletion journal: deletions newer than its last copy may be missing.')
}
const replay = readJournal(journalDir, manifest.createdAt)
const deletedKeys = new Set(replay.flatMap((e) => e.files.map((f) => f.r2Key)))

// 1. Migrations up to the backup's version, and no further.
const subset = join(scratch, 'migrations')
mkdirSync(subset)
for (const m of manifest.migrations) copyFileSync(new URL(`../migrations/${m}`, import.meta.url), join(subset, m))
config(subset)
const existing = d1("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'")
if (existing.length > 0) throw new Error(`Target ${name} is not empty (${existing.map((t) => t.name).join(', ')}): a restore goes into a new database`)
wrangler('d1', 'migrations', 'apply', name, ...where)

// 2-4. Triggers off in this target only, rows in foreign-key order, the same trigger text back.
const present = Object.keys(manifest.tables)
const order = await foreignKeyOrder(d1, present)
const read = (t: string) => JSON.parse(readFileSync(join(backup, `${t}.json`), 'utf8')) as Row[]
const triggers = d1("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name") as { name: string; sql: string }[]
const loadFile = join(scratch, 'load.sql')
writeFileSync(loadFile, restoreSql(order.map((t) => ({ name: t, rows: read(t) })), triggers), { mode: 0o600 })
wrangler('d1', 'execute', name, ...where, '--file', loadFile)

// 5. Prove it: every table's rows and checksum, foreign keys, integrity, all triggers back.
const problems: string[] = []
for (const t of present) {
  const rows = await dumpTable(d1, t)
  if (rows.length !== manifest.tables[t].rows || checksum(rows) !== manifest.tables[t].sha256) problems.push(`${t}: ${rows.length} rows, expected ${manifest.tables[t].rows}, or its checksum differs`)
}
const fk = d1('PRAGMA foreign_key_check')
if (fk.length > 0) problems.push(`foreign_key_check: ${JSON.stringify(fk)}`)
const integrity = d1('PRAGMA quick_check') // D1 refuses integrity_check
if (integrity[0]?.quick_check !== 'ok') problems.push(`quick_check: ${JSON.stringify(integrity)}`)
const after = d1("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name")
if (JSON.stringify(after.map((t) => t.name)) !== JSON.stringify(triggers.map((t) => t.name))) problems.push('triggers differ after the load')

// The objects, to their original keys. Local only: a real file recovery is a separate, deliberate step (runbook).
const files = (read('files') as { r2_key: string; sha256: string }[]).filter((f) => !deletedKeys.has(f.r2_key)) // journaled as deleted: never put back
const mirror = join(homedir(), 'gocreative-backups', 'files')
for (const f of files) {
  const copy = join(mirror, f.sha256)
  if (createHash('sha256').update(readFileSync(copy)).digest('hex') !== f.sha256) problems.push(`mirror copy of ${f.r2_key} is corrupt`)
  else if (!remote) wrangler('r2', 'object', 'put', `${BUCKET}/${f.r2_key}`, '--file', copy, ...where)
}
if (problems.length > 0) {
  console.error(`RESTORE FAILED, scratch kept at ${scratch}:\n${problems.join('\n')}`)
  process.exit(1)
}

// 6. Anything newer than the backup, first: a journal entry can name tables an older backup doesn't have.
config(resolve(new URL('../migrations', import.meta.url).pathname))
wrangler('d1', 'migrations', 'apply', name, ...where)

// 7. Replay deletions made since the backup.
const current = d1("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name") as { name: string; sql: string }[]
const replayText = replaySql(replay, current, (d1("SELECT name FROM sqlite_schema WHERE type = 'table'") as { name: string }[]).map((t) => t.name))
if (replayText) {
  const replayFile = join(scratch, 'replay.sql')
  writeFileSync(replayFile, replayText, { mode: 0o600 })
  wrangler('d1', 'execute', name, ...where, '--file', replayFile)
  const after = d1('PRAGMA foreign_key_check')
  if (after.length > 0) {
    console.error(`RESTORE FAILED after replaying deletions, scratch kept at ${scratch}: ${JSON.stringify(after)}`)
    process.exit(1)
  }
}

const rowCount = Object.values(manifest.tables).reduce((n, t) => n + t.rows, 0)
console.log(`Restored and verified: ${present.length} tables, ${rowCount} rows, ${triggers.length} triggers, ${files.length} files, ${replay.length} deletions replayed.`)
if (!remote) console.log(`To boot on it: npx wrangler dev --persist-to ${state} --var DEV_AUTH_EMAIL:<an active user>\nDelete ${scratch} afterwards: it holds customer data.`)
