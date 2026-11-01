// The offsite bundle: it must open with the passphrase and refuse everything else, leaving no plaintext behind.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { decryptFile, encryptFile } from '../../scripts/unbundle.mjs'

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
