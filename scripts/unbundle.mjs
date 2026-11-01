// Opens an encrypted backup bundle. Plain JavaScript with no dependencies, so it also runs from the USB drive on any machine with Node.
//   node unbundle.mjs <bundle.gcbk> <folder to extract into>
//   node unbundle.mjs --check <bundle.gcbk>      proves it opens, and writes nothing that stays
// The file is AES-256-GCM with a key from the passphrase (scrypt). Nothing is extracted unless the whole file proves authentic.
import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { closeSync, createReadStream, existsSync, createWriteStream, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'

const MAGIC = Buffer.from('GCBK1\n')
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 2 ** 28 + 2 ** 20 }
const key = (passphrase, salt) => scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT)

export async function encryptFile(source, target, passphrase) {
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(passphrase, salt), nonce)
  cipher.setAAD(MAGIC)
  const part = `${target}.part`
  const out = createWriteStream(part, { mode: 0o600 })
  out.write(Buffer.concat([MAGIC, salt, nonce]))
  await pipeline(createReadStream(source), cipher, out, { end: false })
  await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (e) => (e ? reject(e) : resolve())))
  const fd = openSync(part, 'r+')
  fsyncSync(fd) // on the drive, not just in the cache
  closeSync(fd)
  renameSync(part, target) // a drive pulled mid-write leaves a .part, never a bundle that looks complete
}

export async function decryptFile(source, target, passphrase) {
  const fd = openSync(source, 'r')
  const { size } = fstatSync(fd)
  const head = Buffer.alloc(MAGIC.length + 28)
  const tag = Buffer.alloc(16)
  const overhead = head.length + tag.length
  if (size < overhead) { closeSync(fd); throw new Error('This file is too short to be a backup bundle.') }
  readSync(fd, head, 0, head.length, 0)
  readSync(fd, tag, 0, 16, size - 16)
  closeSync(fd)
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This is not a backup bundle.')
  const salt = head.subarray(MAGIC.length, MAGIC.length + 16)
  const nonce = head.subarray(MAGIC.length + 16)
  const decipher = createDecipheriv('aes-256-gcm', key(passphrase, salt), nonce)
  decipher.setAAD(MAGIC)
  decipher.setAuthTag(tag)
  const part = `${target}.part`
  try {
    const input = size === overhead ? null : createReadStream(source, { start: head.length, end: size - 17 })
    if (input) await pipeline(input, decipher, createWriteStream(part, { mode: 0o600 }))
    else { decipher.final(); createWriteStream(part).end() }
    renameSync(part, target)
  } catch {
    rmSync(part, { force: true }) // unverified plaintext is never left behind
    throw new Error('Wrong passphrase, or the bundle is damaged. Nothing was extracted.')
  }
}

/** Turns terminal input into a passphrase: a character split across chunks stays whole, and arrow keys never become part of the key. */
export function passphraseInput() {
  const decoder = new StringDecoder('utf8')
  let text = ''
  return (chunk) => {
    // oxlint-disable-next-line no-control-regex -- escape sequences are what this removes
    const clean = decoder.write(chunk).replace(/\u001b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])?/g, '')
    for (const ch of clean) {
      if (ch === '\u0003') return { cancelled: true }
      if (ch === '\r' || ch === '\n') return { done: true, text }
      if (ch === '\u007f' || ch === '\b') text = [...text].slice(0, -1).join('')
      else text += ch
    }
    return { done: false }
  }
}

export function askPassphrase(prompt) {
  return new Promise((resolve, reject) => {
    if (process.env.BUNDLE_PASSPHRASE) return resolve(process.env.BUNDLE_PASSPHRASE)
    if (!process.stdin.isTTY) return reject(new Error('Run this in a terminal so it can ask for the passphrase.'))
    process.stdout.write(prompt)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    const feed = passphraseInput()
    const onData = (chunk) => {
      const r = feed(chunk)
      if (r.cancelled) { process.stdin.setRawMode(false); process.exit(130) }
      if (r.done) {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdin.off('data', onData)
        process.stdout.write('\n')
        resolve(r.text)
      }
    }
    process.stdin.on('data', onData)
  })
}

const TEMP = 'gocreative-open-'
/** Plaintext left by a machine that lost power last time goes first. A normal failure or Ctrl-C cleans up after itself. */
export function sweepStale(prefix) {
  for (const name of readdirSync(tmpdir())) if (name.startsWith(prefix)) rmSync(join(tmpdir(), name), { recursive: true, force: true })
}

if (process.argv[1] && basename(process.argv[1]) === 'unbundle.mjs') {
  const args = process.argv.slice(2)
  const check = args[0] === '--check'
  const [source, folder] = check ? args.slice(1) : args
  if (!source || (!check && !folder)) {
    console.error('Usage: node unbundle.mjs <bundle.gcbk> <folder to extract into>\n       node unbundle.mjs --check <bundle.gcbk>')
    process.exit(2)
  }
  sweepStale(TEMP)
  const work = join(tmpdir(), `${TEMP}${process.pid}`)
  const extracting = folder ? join(folder, '.extracting') : null
  const clean = () => {
    rmSync(work, { recursive: true, force: true })
    if (extracting) rmSync(extracting, { recursive: true, force: true })
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { clean(); process.exit(1) })
  try {
    const passphrase = await askPassphrase('Passphrase: ')
    mkdirSync(work, { recursive: true, mode: 0o700 })
    const tar = join(work, 'bundle.tar')
    await decryptFile(source, tar, passphrase)
    if (check) {
      console.log(`OK: ${basename(source)} opens and is undamaged.`)
    } else {
      rmSync(extracting, { recursive: true, force: true }) // left by a run that lost power
      mkdirSync(extracting, { recursive: true })
      try {
        execFileSync('tar', ['-xf', tar, '-C', extracting], { stdio: 'inherit' })
      } catch {
        throw new Error('Could not unpack the bundle. Check that tar is available (it is built into Windows 10 and later) and that the disk has room. Nothing was kept.')
      }
      const snapshots = readdirSync(extracting).filter((n) => n !== 'files' && n !== 'journal')
      const taken = snapshots.find((n) => existsSync(join(folder, n)))
      if (taken) throw new Error(`${taken} is already in ${folder}. Nothing was changed.`)
      // All or nothing: a move that fails takes back the ones before it. Files already there are identical by name and stay.
      const moved = []
      const move = (from, to) => {
        renameSync(from, to)
        moved.push(to)
      }
      try {
        for (const name of ['files', 'journal']) {
          if (!existsSync(join(extracting, name))) continue
          mkdirSync(join(folder, name), { recursive: true })
          for (const f of readdirSync(join(extracting, name))) if (!existsSync(join(folder, name, f))) move(join(extracting, name, f), join(folder, name, f))
        }
        for (const n of snapshots) move(join(extracting, n), join(folder, n))
      } catch (e) {
        for (const m of moved) rmSync(m, { recursive: true, force: true })
        throw e
      }
      console.log(`Extracted to ${folder}. It holds customer data: keep it private and delete it when finished.`)
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  } finally {
    clean()
  }
}
