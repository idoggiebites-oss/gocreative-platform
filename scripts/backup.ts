// npm run backup [-- pre-migration]: a consistent snapshot of the live D1 and R2 into ~/gocreative-backups. Holds customer data, so it never goes in this repo.
// Writes pause for the duration (about 2 minutes). Plan and drill: notes/backup-restore.md.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { checksum, dumpTable, expiredBackups, listTables, sqlValue, type BackupInfo, type Row } from './backup-lib.ts'

const ROOT = join(homedir(), 'gocreative-backups')
const DB = 'gocreative'
const BUCKET = 'gocreative-files'
const IN_FLIGHT_WAIT_MS = 30_000 // a request that passed the check just before the switch gets this long to finish
const OFF_ANY = "DELETE FROM settings WHERE key = 'maintenance'" // for a person, after a crash that couldn't clean up

const createdAt = new Date().toISOString()
const owner = `backup ${createdAt}`
const reason = process.argv[2] === 'pre-migration' ? 'pre-migration' : 'weekly'
const wrangler = (...args: string[]) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'] })
const d1 = (sql: string) => (JSON.parse(wrangler('d1', 'execute', DB, '--remote', '--json', '--command', sql)) as { results: Row[] }[])[0].results
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const writeCounts = () => JSON.stringify(d1('SELECT (SELECT COUNT(*) FROM activity_log) AS activity, (SELECT COUNT(*) FROM files) AS files'))

function maintenanceOff() {
  try {
    d1(`${OFF_ANY} AND value = ${sqlValue(owner)}`) // only this run's pause, never another backup's
    console.log('Maintenance off: writes are open.')
  } catch (e) {
    console.error(`!! WRITES ARE STILL PAUSED. Run: npx wrangler d1 execute ${DB} --remote --command "${OFF_ANY}"`)
    throw e
  }
}

function mirrorFiles(files: { key: string; sha256: string; bytes: number }[]) {
  const mirror = join(ROOT, 'files')
  mkdirSync(mirror, { recursive: true, mode: 0o700 })
  for (const f of files) {
    const target = join(mirror, f.sha256)
    if (!existsSync(target)) {
      const part = `${target}.part`
      wrangler('r2', 'object', 'get', `${BUCKET}/${f.key}`, '--remote', '--file', part)
      renameSync(part, target)
    }
    // Every time, not just on download: a backup is complete only when each mirrored copy still hashes right.
    if (sha256(target) !== f.sha256) throw new Error(`Mirror copy of ${f.key} does not match its recorded SHA-256`)
  }
}

function prune() {
  const backups: (BackupInfo & { files: string })[] = []
  for (const dir of readdirSync(ROOT)) {
    const manifest = join(ROOT, dir, 'manifest.json')
    if (!existsSync(manifest)) continue // incomplete, or older than this script: left for a person to judge
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as BackupInfo
    backups.push({ ...m, dir, files: join(ROOT, dir, 'files.json') })
  }
  const expired = expiredBackups(backups, new Date())
  for (const b of expired) {
    rmSync(join(ROOT, b.dir), { recursive: true })
    console.log(`Expired ${b.dir}`)
  }
  const gone = new Set(expired.map((b) => b.dir))
  const referenced = new Set(backups.filter((b) => !gone.has(b.dir)).flatMap((b) => (JSON.parse(readFileSync(b.files, 'utf8')) as { sha256: string }[]).map((f) => f.sha256)))
  const mirror = join(ROOT, 'files')
  for (const name of readdirSync(mirror)) if (!referenced.has(name)) rmSync(join(mirror, name))
}

const started = Date.now()
const dir = join(ROOT, createdAt.replace(/[:.]/g, '-'))
if (d1("SELECT 1 FROM settings WHERE key = 'maintenance'").length > 0) throw new Error(`Maintenance is already on: another backup running, or a crashed one. If none is running, clear it: npx wrangler d1 execute ${DB} --remote --command "${OFF_ANY}"`)
mkdirSync(dir, { recursive: true, mode: 0o700 })

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => {
    maintenanceOff()
    process.exit(1)
  })
}
try {
  // Inside the try: the insert can commit and still report failure.
  d1(`INSERT INTO settings (key, value) VALUES ('maintenance', ${sqlValue(owner)})`)
  console.log('Maintenance on: writes paused.')
  await new Promise((r) => setTimeout(r, IN_FLIGHT_WAIT_MS))
  const before = writeCounts()
  const bookmark = JSON.parse(wrangler('d1', 'time-travel', 'info', DB, '--json')) as unknown
  const migrations = d1('SELECT name FROM d1_migrations ORDER BY id').map((r) => String(r.name))
  const tables: Record<string, { rows: number; sha256: string }> = {}
  for (const name of await listTables(d1)) {
    const rows = await dumpTable(d1, name)
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(rows, null, 1), { mode: 0o600 })
    tables[name] = { rows: rows.length, sha256: checksum(rows) }
    console.log(`${name}: ${rows.length}`)
  }
  const fileRows = JSON.parse(readFileSync(join(dir, 'files.json'), 'utf8')) as { r2_key: string; sha256: string; bytes: number; mime: string }[]
  const files = fileRows.map((f) => ({ key: f.r2_key, sha256: f.sha256, bytes: f.bytes, mime: f.mime }))
  mirrorFiles(files)
  if (writeCounts() !== before) throw new Error('Rows were written during the backup: this snapshot is not consistent')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  // Written last: no manifest means an incomplete backup.
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ createdAt, reason, commit, bookmark, migrations, tables, files: { count: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) }, durationMs: Date.now() - started }, null, 1), { mode: 0o600 })
} finally {
  maintenanceOff()
}
prune()
console.log(`Backup complete: ${dir}`)
