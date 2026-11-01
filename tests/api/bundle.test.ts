// The offsite bundle: it must open with the passphrase and refuse everything else, leaving no plaintext behind.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { decryptFile, encryptFile, passphraseInput } from '../../scripts/unbundle.mjs'

const dir = mkdtempSync(join(tmpdir(), 'bundle-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const PASS = 'correct horse battery staple'
const secret = 'Rosa Medrano, rosa@example.com, 555-010-7788'

test('round trip, with the plaintext nowhere in the bundle', async () => {
  writeFileSync(join(dir, 'a.tar'), secret)
  await encryptFile(join(dir, 'a.tar'), join(dir, 'a.gcbk'), PASS)
  expect(readFileSync(join(dir, 'a.gcbk')).includes(Buffer.from('Medrano'))).toBe(false)
  await decryptFile(join(dir, 'a.gcbk'), join(dir, 'a.out'), PASS)
  expect(readFileSync(join(dir, 'a.out'), 'utf8')).toBe(secret)
  expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
})

test('a wrong passphrase, a flipped bit and a truncated file all refuse, and leave nothing behind', async () => {
  writeFileSync(join(dir, 'b.tar'), secret)
  await encryptFile(join(dir, 'b.tar'), join(dir, 'b.gcbk'), PASS)
  await expect(decryptFile(join(dir, 'b.gcbk'), join(dir, 'b1'), 'not the passphrase at all')).rejects.toThrow(/Wrong passphrase/)
  const good = readFileSync(join(dir, 'b.gcbk'))
  const flipped = Buffer.from(good)
  flipped[flipped.length - 20] ^= 1
  writeFileSync(join(dir, 'c.gcbk'), flipped)
  await expect(decryptFile(join(dir, 'c.gcbk'), join(dir, 'b2'), PASS)).rejects.toThrow(/damaged/)
  writeFileSync(join(dir, 'd.gcbk'), good.subarray(0, good.length - 5))
  await expect(decryptFile(join(dir, 'd.gcbk'), join(dir, 'b3'), PASS)).rejects.toThrow(/damaged/)
  writeFileSync(join(dir, 'e.gcbk'), 'just some other file, long enough to read a header from')
  await expect(decryptFile(join(dir, 'e.gcbk'), join(dir, 'b4'), PASS)).rejects.toThrow(/not a backup bundle/)
  for (const f of ['b1', 'b2', 'b3', 'b4', 'b1.part', 'b2.part', 'b3.part', 'b4.part']) expect(() => statSync(join(dir, f))).toThrow()
})

test('a salt per bundle: the same data and passphrase never produce the same file', async () => {
  writeFileSync(join(dir, 'f.tar'), secret)
  await encryptFile(join(dir, 'f.tar'), join(dir, 'f1.gcbk'), PASS)
  await encryptFile(join(dir, 'f.tar'), join(dir, 'f2.gcbk'), PASS)
  expect(readFileSync(join(dir, 'f1.gcbk')).equals(readFileSync(join(dir, 'f2.gcbk')))).toBe(false)
})

test('passphrase input: a character split across chunks stays whole, and arrow keys and backspace are not part of the key', () => {
  const type = (...chunks: Buffer[]) => { const feed = passphraseInput(); let last; for (const c of chunks) last = feed(c); return last }
  const e = Buffer.from('é')
  expect(type(Buffer.from('caf'), e.subarray(0, 1), e.subarray(1), Buffer.from('\r'))).toEqual({ done: true, text: 'café' })
  expect(type(Buffer.from('ab\u001b[Dc\u007fd\r'))).toEqual({ done: true, text: 'abd' })
})

// The real commands, on a fixture backup. Node strips the types; nothing here touches production.
const SCRIPT = new URL('../../scripts/bundle.ts', import.meta.url).pathname
const OPEN = new URL('../../scripts/unbundle.mjs', import.meta.url).pathname
function fixture(createdAt: string, root = mkdtempSync(join(dir, 'root-'))) {
  const name = createdAt.replace(/[:.]/g, '-')
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'users.json'), '[]')
  writeFileSync(join(root, name, 'files.json'), '[]')
  writeFileSync(join(root, name, 'manifest.json'), JSON.stringify({ createdAt, reason: 'weekly', tables: { users: { rows: 0, sha256: createHash('sha256').update('[]').digest('hex') } } }))
  return root
}
const bundle = (root: string, usb: string, pass = PASS) => spawnSync(process.execPath, [SCRIPT, usb], { encoding: 'utf8', env: { ...process.env, BUNDLE_ROOT: root, BUNDLE_PASSPHRASE: pass } })
const bundles = (usb: string) => readdirSync(usb).filter((f) => f.endsWith('.gcbk')).sort()

test('a failed run never touches a good copy; pruning keeps only copies that open, and corrupt ones cannot push out the new one', () => {
  const usb = mkdtempSync(join(dir, 'usb-'))
  const root = fixture('2026-01-01T00:00:00.000Z')
  expect(bundle(root, usb).status).toBe(0)
  const first = bundles(usb)[0]
  const good = readFileSync(join(usb, first))
  // A broken backup fails verification: the good copy stays, and no candidate is left behind.
  const broken = fixture('2026-01-02T00:00:00.000Z', root)
  writeFileSync(join(broken, '2026-01-02T00-00-00-000Z', 'users.json'), '[{"id":1}]')
  expect(bundle(root, usb).status).not.toBe(0)
  expect(bundles(usb)).toEqual([first])
  expect(readFileSync(join(usb, first)).equals(good)).toBe(true)
  expect(readdirSync(usb).filter((f) => f.includes('candidate') || f.includes('.part'))).toEqual([])
  rmSync(join(root, '2026-01-02T00-00-00-000Z'), { recursive: true })
  // Two newer-named corrupt files can't cost the good ones.
  writeFileSync(join(usb, 'gocreative-backup-2999-a-delete-after-3000-01-01.gcbk'), 'junk junk junk junk junk junk junk junk junk junk junk')
  writeFileSync(join(usb, 'gocreative-backup-2999-b-delete-after-3000-01-01.gcbk'), 'junk junk junk junk junk junk junk junk junk junk junk')
  fixture('2026-01-03T00:00:00.000Z', root)
  const r = bundle(root, usb)
  expect(r.status).toBe(0)
  expect(r.stderr + r.stdout).toContain('does not open')
  const after = bundles(usb)
  expect(after).toContain(first)
  expect(after.some((f) => f.includes('2026-01-03'))).toBe(true)
  // A third good one retires the oldest, and only then.
  fixture('2026-01-04T00:00:00.000Z', root)
  expect(bundle(root, usb).status).toBe(0)
  expect(bundles(usb)).not.toContain(first)
  expect(bundles(usb).some((f) => f.includes('2026-01-03'))).toBe(true)
  expect(bundles(usb).some((f) => f.includes('2026-01-04'))).toBe(true)
}, 120_000) // real commands with real scrypt: seconds each

test('the drive copy opens with its own tool; --check and a failed extraction leave no plaintext behind', () => {
  const usb = mkdtempSync(join(dir, 'usb-'))
  const root = fixture('2026-02-01T00:00:00.000Z')
  expect(bundle(root, usb).status).toBe(0)
  const file = join(usb, bundles(usb)[0])
  expect(existsSync(join(usb, 'RECOVERY-README.txt'))).toBe(true)
  const run = (args: string[], env: object = {}) => spawnSync(process.execPath, [join(usb, 'unbundle.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, BUNDLE_PASSPHRASE: PASS, ...env } })
  expect(run(['--check', file]).stdout).toContain('OK')
  expect(run(['--check', file], { BUNDLE_PASSPHRASE: 'wrong wrong wrong wrong' }).status).toBe(1)
  const out = mkdtempSync(join(dir, 'out-'))
  const noTar = run([file, out], { PATH: '/nonexistent' })
  expect(noTar.status).toBe(1)
  expect(noTar.stderr).toContain('Nothing was kept')
  expect(readdirSync(out)).toEqual([])
  expect(run([file, out]).status).toBe(0)
  expect(readdirSync(out).sort()).toEqual(['2026-02-01T00-00-00-000Z'])
  expect(OPEN.endsWith('unbundle.mjs')).toBe(true)
  // A second extraction changes nothing and says why; plaintext staged by a lost-power run is cleared.
  const before = readFileSync(join(out, '2026-02-01T00-00-00-000Z', 'manifest.json'))
  mkdirSync(join(out, '.extracting'))
  writeFileSync(join(out, '.extracting', 'stale'), 'old plaintext')
  const again = run([file, out])
  expect(again.status).toBe(1)
  expect(again.stderr).toContain('already in')
  expect(existsSync(join(out, '.extracting'))).toBe(false)
  expect(readFileSync(join(out, '2026-02-01T00-00-00-000Z', 'manifest.json')).equals(before)).toBe(true)
}, 120_000)
