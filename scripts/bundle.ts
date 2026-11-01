// npm run backup:bundle -- <folder on the USB drive>: encrypts the newest complete backup for the offsite machine, reads the copy back to
// prove it opens and matches, and leaves only the newest two bundles on the drive. Read-only towards production. Plan: notes/backup-restore.md.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { checksum, type Row } from './backup-lib.ts'
import { askPassphrase, decryptFile, encryptFile, sweepStale } from './unbundle.mjs'

const ROOT = process.env.BUNDLE_ROOT ?? join(homedir(), 'gocreative-backups')
const REPO = resolve(new URL('..', import.meta.url).pathname)
const KEEP_DAYS = 56 // the 8 weeks the backup plan promises
const MIN_PASSPHRASE = 16

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
type Manifest = { createdAt: string; tables: Record<string, { rows: number; sha256: string }> }

function newestBackup() {
  const found = readdirSync(ROOT).flatMap((dir) => {
    const path = join(ROOT, dir, 'manifest.json')
    return existsSync(path) ? [{ dir, createdAt: (JSON.parse(readFileSync(path, 'utf8')) as Manifest).createdAt }] : []
  })
  found.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  if (!found[0]) throw new Error(`No complete backup in ${ROOT}. Run npm run backup first.`)
  return found[0]
}

/** Everything a restore needs is in the extracted folder: same manifest, same checksums, every file's hash. */
export function verifyExtracted(root: string, dir: string, expected: { filesHeld: string[]; journal: string[] }) {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'manifest.json'), 'utf8')) as Manifest
  for (const [table, want] of Object.entries(manifest.tables)) {
    const rows = JSON.parse(readFileSync(join(root, dir, `${table}.json`), 'utf8')) as Row[]
    if (rows.length !== want.rows || checksum(rows) !== want.sha256) throw new Error(`${table} does not match its manifest`)
  }
  for (const hash of expected.filesHeld) if (sha256(join(root, 'files', hash)) !== hash) throw new Error(`File ${hash} does not match its hash`)
  for (const name of expected.journal) if (!existsSync(join(root, 'journal', name))) throw new Error(`Journal entry ${name} is missing`)
}

const destination = process.argv[2]
if (!destination) throw new Error('Usage: npm run backup:bundle -- <folder on the USB drive>')
if (!existsSync(destination) || !statSync(destination).isDirectory()) throw new Error(`${destination} is not a folder. Is the drive plugged in?`)
const dest = realpathSync(destination)
const inside = (parent: string) => { const r = relative(realpathSync(parent), dest); return r === '' || (!r.startsWith('..') && !r.startsWith('/')) }
if (inside(REPO)) throw new Error('Refusing to write customer data inside the public repository.')
if (inside(ROOT)) throw new Error('That is the backup folder on this Mac, not an offsite copy.')

const { dir, createdAt } = newestBackup()
const ageDays = (Date.now() - Date.parse(createdAt)) / 86_400_000
if (ageDays > 7) console.warn(`!! The newest backup is ${Math.floor(ageDays)} days old. Run npm run backup first for a current copy.`)

const passphrase = await askPassphrase('Passphrase (at least 16 characters; keep it in a password manager, NOT on the drive): ')
if (passphrase.length < MIN_PASSPHRASE) throw new Error(`The passphrase must be at least ${MIN_PASSPHRASE} characters.`)
if (!process.env.BUNDLE_PASSPHRASE && (await askPassphrase('Again: ')) !== passphrase) throw new Error('The two passphrases differ. Nothing was written.')

const filesHeld = [...new Set((JSON.parse(readFileSync(join(ROOT, dir, 'files.json'), 'utf8')) as { sha256: string }[]).map((f) => f.sha256))]
const journalDir = join(ROOT, 'journal')
const journal = existsSync(journalDir) ? readdirSync(journalDir).filter((f) => f.endsWith('.json')) : []
const members = [dir, ...filesHeld.map((h) => join('files', h)), ...journal.map((j) => join('journal', j))]

sweepStale('gocreative-bundle-') // plaintext from a run that lost power
const scratch = mkdtempSync(join(tmpdir(), 'gocreative-bundle-'))
let candidate = ''
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { rmSync(scratch, { recursive: true, force: true }); process.exit(1) })
try {
  const list = join(scratch, 'members.txt')
  writeFileSync(list, members.join('\n') + '\n', { mode: 0o600 })
  const tar = join(scratch, 'bundle.tar')
  execFileSync('tar', ['-cf', tar, '-C', ROOT, '-T', list], { stdio: 'inherit' })
  const needed = statSync(tar).size * 2.2
  const free = statfsSync(dest).bavail * statfsSync(dest).bsize
  if (free < needed) throw new Error(`The drive has too little free space: ${Math.ceil(needed / 2 ** 20)} MB needed.`)

  const stamp = createdAt.replace(/[:.]/g, '-')
  const expires = new Date(Date.parse(createdAt) + KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)
  const name = `gocreative-backup-${stamp}-delete-after-${expires}.gcbk`
  const target = join(dest, name)
  candidate = `${target}.candidate`
  await encryptFile(tar, candidate, passphrase)

  // Read the drive's copy back. Only a copy that opens and matches takes a bundle's name; an existing good copy is untouched until then.
  const check = join(scratch, 'check')
  mkdirSync(check, { mode: 0o700 })
  await decryptFile(candidate, join(check, 'bundle.tar'), passphrase)
  execFileSync('tar', ['-xf', 'bundle.tar'], { cwd: check })
  verifyExtracted(check, dir, { filesHeld, journal })
  rmSync(join(check, 'bundle.tar'))
  renameSync(candidate, target)

  copyFileSync(new URL('./unbundle.mjs', import.meta.url), join(dest, 'unbundle.mjs'))
  copyFileSync(new URL('./RECOVERY-README.txt', import.meta.url), join(dest, 'RECOVERY-README.txt'))

  // Keep the new bundle and the newest other one that really opens with this passphrase. Anything else goes only once a good pair exists.
  const others = readdirSync(dest).filter((f) => /^gocreative-backup-.*\.gcbk$/.test(f) && f !== name).sort().reverse()
  const older: string[] = []
  let kept = false
  for (const f of others) {
    const probe = join(scratch, 'probe.tar')
    const opens = await decryptFile(join(dest, f), probe, passphrase).then(() => true, () => false)
    rmSync(probe, { force: true })
    if (opens && !kept) {
      kept = true
    } else if (opens) {
      rmSync(join(dest, f))
      older.push(f)
    } else {
      console.warn(`!! ${f} does not open with this passphrase. It was left in place: check or remove it yourself.`)
    }
  }

  console.log(`Written and verified: ${name}`)
  console.log(`${members.length} items, ${Math.ceil(statSync(target).size / 1024)} KB. Backup taken ${createdAt}.`)
  console.log(`Eject the drive safely. To re-check it after reconnecting, or on the offsite machine: node unbundle.mjs --check "${name}"`)
  console.log(`On the offsite machine: copy it over, check it, then delete any bundle whose delete-after date has passed.`)
  if (older.length > 0) console.log(`Removed from the drive: ${older.join(', ')}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
  if (candidate) { rmSync(candidate, { force: true }); rmSync(`${candidate}.part`, { force: true }) } // a refused copy never stays on the drive
}
