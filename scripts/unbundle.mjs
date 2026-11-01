// Opens an encrypted backup bundle. Plain JavaScript with no dependencies, so it also runs from the USB drive on any machine with Node.
//   node unbundle.mjs <bundle.gcbk> <folder to extract into>
// The file is AES-256-GCM with a key from the passphrase (scrypt). Nothing is extracted unless the whole file proves authentic.
import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

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

export function askPassphrase(prompt) {
  return new Promise((resolve, reject) => {
    if (process.env.BUNDLE_PASSPHRASE) return resolve(process.env.BUNDLE_PASSPHRASE)
    if (!process.stdin.isTTY) return reject(new Error('Run this in a terminal so it can ask for the passphrase.'))
    process.stdout.write(prompt)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    let text = ''
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003') { process.stdin.setRawMode(false); process.exit(130) }
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.off('data', onData)
          process.stdout.write('\n')
          return resolve(text)
        }
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1)
        else text += ch
      }
    }
    process.stdin.on('data', onData)
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [source, folder] = process.argv.slice(2)
  if (!source || !folder) {
    console.error('Usage: node unbundle.mjs <bundle.gcbk> <folder to extract into>')
    process.exit(2)
  }
  try {
    const passphrase = await askPassphrase('Passphrase: ')
    mkdirSync(folder, { recursive: true })
    const tar = `${folder}/.bundle.tar`
    await decryptFile(source, tar, passphrase)
    execFileSync('tar', ['-xf', '.bundle.tar'], { cwd: folder, stdio: 'inherit' })
    rmSync(tar)
    console.log(`Extracted to ${folder}. It holds customer data: keep it private and delete it when finished.`)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
