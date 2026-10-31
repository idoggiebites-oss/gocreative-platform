// Uploads on workerd itself: the real Worker (worker/index.ts, bundled by wrangler's unstable_dev) with local D1 and
// R2 on a throwaway persist dir, driven over HTTP. tests/api runs the same code in Node with stand-ins for
// FixedLengthStream and crypto.DigestStream; this proves the streaming path (Codex security review of 1729ff4) on
// the runtime that ships. The last test stops the Worker and checks D1 and R2 agree: every uploaded object has its
// files row and every files row its object. Part of `npm test` (a few seconds).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPlatformProxy, unstable_dev } from 'wrangler'

const dir = mkdtempSync(join(tmpdir(), 'gocreative-uploads-'))
const config = join(dir, 'wrangler.json')
let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined

beforeAll(async () => {
  // The app's bindings without its assets (built by vite, not needed here), and the localhost-only dev sign-in.
  writeFileSync(config, JSON.stringify({
    name: 'gocreative-uploads-test', main: resolve('worker/index.ts'), compatibility_date: '2026-10-01',
    d1_databases: [{ binding: 'DB', database_name: 'gocreative', database_id: 'local-test', migrations_dir: resolve('migrations') }],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'gocreative-files' }],
    vars: { DEV_AUTH_EMAIL: 'owner1@example.com' },
  }))
  const wrangler = (...args: string[]) => execFileSync('npx', ['wrangler', 'd1', ...args, '--local', '--persist-to', dir, '--config', config], { stdio: 'pipe' })
  wrangler('migrations', 'apply', 'gocreative')
  wrangler('execute', 'gocreative', '--file', 'scripts/seed.sql')
  worker = await unstable_dev(resolve('worker/index.ts'), {
    config, persistTo: dir, ip: '127.0.0.1', port: 0, logLevel: 'none',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
  })
}, 90_000)
afterAll(async () => {
  await worker?.stop()
  rmSync(dir, { recursive: true, force: true })
})

// Straight to the port: unstable_dev's worker.fetch re-sends a body chunked, dropping its Content-Length.
const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${worker!.port}/api/app${path}`, init)
const version = async (n: string) => ((await (await api(`/orders/${n}`)).json()) as { order: { version: number } }).order.version
const png = (size: number) => {
  const b = new Uint8Array(size)
  for (let i = 0; i < size; i++) b[i] = (i * 31) & 0xff
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return b
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const expected = new Map<number, string>() // artwork id → sha256 of what was sent

test('an SVG version: stored, re-derived, downloaded back; a stale version touches nothing', async () => {
  const v = await version('2026-0017')
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  const res = await api(`/orders/2026-0017/artwork?expectedVersion=${v}&lineageId=17`,
    { method: 'POST', body: svg, headers: { 'Content-Type': 'image/svg+xml', 'X-Filename': 'logo%20v2.svg' } })
  expect(res.status).toBe(201)
  const { id, productionStatus } = (await res.json()) as { id: number; productionStatus: string }
  expect(productionStatus).toBe('awaiting_artwork') // the new version reset approval, and the re-derive saw it
  expected.set(id, sha(svg))
  const { designs } = (await (await api('/orders/2026-0017/artwork')).json()) as { designs: { versions: { id: number; file: { id: number; filename: string } }[] }[] }
  const file = designs.flatMap((d) => d.versions).find((x) => x.id === id)!.file
  expect(file.filename).toBe('logo v2.svg')
  const dl = await api(`/files/${file.id}`)
  expect(dl.headers.get('content-disposition')).toMatch(/^attachment;/)
  expect(await dl.text()).toBe(new TextDecoder().decode(svg))
  const stale = await api(`/orders/2026-0017/artwork?expectedVersion=${v}`, { method: 'POST', body: svg, headers: { 'Content-Type': 'image/svg+xml' } })
  expect(stale.status).toBe(409)
})

test('a multi-MB upload streams into R2 whole, with its SHA-256', async () => {
  const big = png(12 * 1024 * 1024 + 7)
  const res = await api(`/orders/2026-0022/artwork?expectedVersion=${await version('2026-0022')}`,
    { method: 'POST', body: big, headers: { 'Content-Type': 'image/png' } })
  expect(res.status).toBe(201)
  const { id } = (await res.json()) as { id: number }
  expected.set(id, sha(big))
  const { designs } = (await (await api('/orders/2026-0022/artwork')).json()) as { designs: { versions: { id: number; file: { id: number; bytes: number } }[] }[] }
  const file = designs.flatMap((d) => d.versions).find((x) => x.id === id)!.file
  expect(file.bytes).toBe(big.byteLength)
  expect(sha(new Uint8Array(await (await api(`/files/${file.id}`)).arrayBuffer()))).toBe(sha(big))
}, 30_000)

test('no Content-Length (a chunked body) is 411', async () => {
  const v = await version('2026-0022')
  const body = new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(png(1024)); c.close() } })
  const res = await api(`/orders/2026-0022/artwork?expectedVersion=${v}`, { method: 'POST', body, headers: { 'Content-Type': 'image/png' }, duplex: 'half' } as RequestInit)
  expect(res.status).toBe(411)
  expect(await res.json()).toMatchObject({ code: 'length_required' })
})

test('a body that ends short of its Content-Length is refused', async () => {
  const v = await version('2026-0022')
  const sent = png(256 * 1024)
  // fetch won't send a lying Content-Length, so this is raw HTTP: 1 MB declared, 256 KB sent, then the client stops sending.
  const reply = await new Promise<string>((done, fail) => {
    const s = connect(worker!.port, '127.0.0.1', () => {
      s.write(`POST /api/app/orders/2026-0022/artwork?expectedVersion=${v} HTTP/1.1\r\nHost: localhost\r\nContent-Type: image/png\r\n`
        + `Content-Length: ${1024 * 1024}\r\nConnection: close\r\n\r\n`)
      s.write(sent, () => s.end())
    })
    let out = ''
    s.on('data', (d) => (out += d.toString('latin1')))
    s.on('end', () => done(out))
    s.on('close', () => done(out))
    s.on('error', fail)
  })
  // Locally wrangler's dev proxy answers 500 "Network connection lost" (the body stream broke under the Worker); the
  // Worker's own 400 for this case is tested in tests/api. Either way nothing is stored or written (the last test).
  expect(reply === '' || /^HTTP\/1\.1 (400|500)/.test(reply), reply.slice(0, 200)).toBe(true)
  expect(await version('2026-0022')).toBe(v)
}, 30_000)

test('D1 and R2 agree: every uploaded object has its files row (with the right hash), and no refused upload left one', async () => {
  await worker!.stop()
  worker = undefined
  const proxy = await getPlatformProxy<{ DB: D1Database; FILES: R2Bucket }>({ configPath: config, persist: { path: join(dir, 'v3') }, remoteBindings: false })
  try {
    const rows = (await proxy.env.DB.prepare(`SELECT a.id, f.r2_key, f.sha256 FROM files f JOIN artwork a ON a.file_id = f.id WHERE f.r2_key LIKE 'orders/%'`)
      .all<{ id: number; r2_key: string; sha256: string }>()).results
    expect(new Map(rows.map((r) => [r.id, r.sha256]))).toEqual(expected)
    const listed = await proxy.env.FILES.list({ prefix: 'orders/' })
    expect(listed.objects.map((o) => o.key).sort()).toEqual(rows.map((r) => r.r2_key).sort())
    for (const r of rows) expect(r.r2_key).toMatch(/^orders\/\d+\/[0-9a-f-]{36}$/)
  } finally {
    await proxy.dispose()
  }
}, 60_000)
