// The public API. Seeded with internal notes, other customers and supplier costs so a leak has something to leak.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanupIntake } from '../../worker/cron'
import { CLEANUP_BATCH, DAILY_MAX_SESSIONS, IP_SESSIONS_PER_HOUR, OPEN_SESSIONS_MAX, ORPHAN_PAGES_PER_RUN, OUTSTANDING_MAX_BYTES, SESSION_MAX_ATTEMPTS, SESSION_MAX_FILES, newRef } from '../../worker/domain/intake'
import { app } from '../../worker/index'
import { INQUIRY_STATUSES } from '../../shared/enums'
import { createTestD1 } from './d1'
import { JPEG, PDF, PNG, SVG, HTML, createTestR2 } from './r2'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
const HOST = 'gocreative.test'

function setup() {
  const { db, sqlite } = createTestD1()
  sqlite.exec(seed)
  sqlite.exec("DELETE FROM settings WHERE key = 'intake_closed'")
  const r2 = createTestR2()
  const env = { DB: db, FILES: r2.bucket, TURNSTILE_SECRET: 's', IP_HASH_SALT: 'salt' } as unknown as Env
  const call = (path: string, init: RequestInit = {}, ip = '203.0.113.1') =>
    app.request(`https://${HOST}/api/public${path}`, { ...init, headers: { 'CF-Connecting-IP': ip, ...init.headers } }, env)
  const open = async (ip = '203.0.113.1') => {
    const res = await call('/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnstileToken: 'good' }) }, ip)
    expect(res.status).toBe(201)
    return ((await res.json()) as { token: string }).token
  }
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
  const upload = (token: string, bytes: Uint8Array = PNG, o: { type?: string; purpose?: string; length?: number; filename?: string } = {}) => call('/submissions/files', {
    method: 'POST', body: bytes as Uint8Array<ArrayBuffer>,
    headers: { ...auth(token), 'Content-Type': o.type ?? 'image/png', 'X-File-Purpose': o.purpose ?? 'artwork', 'Content-Length': String(o.length ?? bytes.byteLength), ...(o.filename ? { 'X-Filename': o.filename } : {}) },
  })
  const submit = (token: string, body: unknown = FORM) => call('/submissions/submit', { method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const n = (sql: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n
  const expire = () => sqlite.exec("DROP TRIGGER submissions_identity_fixed; UPDATE inquiry_submissions SET expires_at = '2000-01-01T00:00:00.000Z'")
  return { sqlite, db, r2, env, call, open, auth, upload, submit, n, expire }
}
const FORM = { customerKind: 'district', organization: 'Test ISD', contactName: 'Pat Doe', contactEmail: 'pat@example.com', lines: [{ product: 'tshirts', method: 'screen', quantity: 3, sizes: { M: 2, L: 1 }, color: 'Navy' }] }

let turnstile: ReturnType<typeof vi.fn>
beforeEach(() => {
  turnstile = vi.fn(async (_url: string, init: RequestInit) => {
    const token = (init.body as URLSearchParams).get('response')
    if (token === 'down') throw new Error('network')
    const reply = token === 'good' ? { success: true, hostname: HOST, action: 'inquiry' }
      : token === 'wrong-host' ? { success: true, hostname: 'evil.example', action: 'inquiry' }
      : token === 'wrong-action' ? { success: true, hostname: HOST, action: 'login' }
      : { success: false, 'error-codes': ['timeout-or-duplicate'] }
    return new Response(JSON.stringify(reply))
  })
  vi.stubGlobal('fetch', turnstile)
})
afterEach(() => vi.unstubAllGlobals())

const code = async (r: Response) => [r.status, ((await r.clone().json()) as { code?: string }).code]

test('as migrated, intake is closed: every public write refuses and status says so', async () => {
  const t = setup()
  t.sqlite.exec("INSERT INTO settings (key, value) VALUES ('intake_closed', 'x')")
  expect(await code(await t.call('/submissions', { method: 'POST', body: '{}' }))).toEqual([503, 'intake_closed'])
  expect(await (await t.call('/status')).json()).toEqual({ open: false })
  expect(turnstile).not.toHaveBeenCalled()
  // The migration itself ships the row.
  const fresh = createTestD1()
  expect(fresh.sqlite.prepare("SELECT value FROM settings WHERE key = 'intake_closed'").get()).toBeTruthy()
})

test('the whole path: session, uploads, submit; a reference comes back and nothing else', async () => {
  const t = setup()
  const token = await t.open()
  const res = await t.upload(token, PNG, { filename: 'logo.png' })
  expect(res.status).toBe(201)
  const ack = await res.json() as Record<string, unknown>
  expect(Object.keys(ack).sort()).toEqual(['bytes', 'filename', 'id'])
  const sent = await t.submit(token)
  expect(sent.status).toBe(201)
  const body = await sent.json() as { ref: string }
  expect(Object.keys(body)).toEqual(['ref'])
  expect(body.ref).toMatch(/^INQ-[2-9A-HJ-NP-Z]{6}$/)
  const row = t.sqlite.prepare('SELECT status, contact_name, customer_kind, order_id, payload FROM inquiries WHERE ref = ?').get(body.ref) as Record<string, string>
  expect(row).toMatchObject({ status: 'new', contact_name: 'Pat Doe', customer_kind: 'district', order_id: null })
  expect(JSON.parse(row.payload).lines[0].sizes).toEqual({ M: 2, L: 1 })
  expect(t.n("inquiry_files WHERE status = 'linked' AND inquiry_id IS NOT NULL AND file_id IS NOT NULL")).toBe(1)
  expect(t.sqlite.prepare("SELECT via_portal, uploaded_by, filename FROM files WHERE r2_key LIKE 'inquiries/%'").get()).toEqual({ via_portal: 1, uploaded_by: null, filename: 'logo.png' })
  const audit = t.sqlite.prepare("SELECT actor_kind, after FROM activity_log WHERE action = 'inquiry_received'").get() as { actor_kind: string; after: string }
  expect(audit).toEqual({ actor_kind: 'portal', after: '{"files":1}' })
  expect(audit.after).not.toContain('Pat')
})

test('no response contains internal data, whatever the request', async () => {
  const t = setup()
  const secrets = t.sqlite.prepare("SELECT body AS v FROM notes UNION SELECT name FROM customers UNION SELECT email FROM users UNION SELECT r2_key FROM files").all() as { v: string }[]
  expect(secrets.length).toBeGreaterThan(3)
  const token = await t.open()
  const replies = [
    await t.call('/status'),
    await t.upload(token),
    await t.upload(token, HTML, { type: 'text/html' }),
    await t.submit(token, { ...FORM, customerId: 1 }),
    await t.submit('x'.repeat(30)),
    await t.call('/orders'),
    await t.call('/submissions/files/1'),
    await t.submit(token),
    await t.submit(token),
  ]
  for (const r of replies) {
    const text = await r.text()
    for (const s of secrets) expect(text).not.toContain(s.v)
    expect(text).not.toContain('inquiries/') // not even our own storage keys
    expect(text).not.toMatch(/<html|<!doctype/i) // Worker errors, never SPA HTML
  }
})

test('attacker-supplied internal fields are refused, not ignored', async () => {
  const t = setup()
  const token = await t.open()
  for (const extra of [{ status: 'converted' }, { order_id: 1 }, { customerId: 1 }, { unit_price_cents: 0 }, { notes: 'x' }, { ref: 'INQ-AAAAAA' }]) {
    expect((await t.submit(token, { ...FORM, ...extra })).status, JSON.stringify(extra)).toBe(400)
  }
  expect((await t.submit(token, { ...FORM, lines: [{ ...FORM.lines[0], unit_price_cents: 1 }] })).status).toBe(400)
  expect(t.n('inquiries')).toBe(0)
})

test('the form rules hold on the server: method fits product, sizes add up, a contact is required', async () => {
  const t = setup()
  const token = await t.open()
  const line = FORM.lines[0]
  for (const bad of [
    { lines: [{ product: 'tshirts', method: 'laser_engrave', quantity: 1 }] }, // you can't laser a shirt
    { lines: [{ product: 'hats', method: 'screen', quantity: 1 }] },
    { lines: [{ product: 'nope', method: 'screen', quantity: 1 }] },
    { lines: [{ ...line, quantity: 9 }] },
    { lines: [{ ...line, sizes: { XXXXL: 3 } }] },
    { lines: [{ product: 'hats', method: 'embroidery', quantity: 3, sizes: { M: 3 } }] },
    { lines: [] },
    { contactEmail: undefined },
    { contactEmail: 'not-an-email' },
    { preferredContact: 'phone' },
    { dueDate: 'soon' },
  ]) expect((await t.submit(token, { ...FORM, ...bad })).status, JSON.stringify(bad)).toBe(400)
  expect((await t.submit(token, { ...FORM, lines: [{ product: 'trophies', method: 'help', quantity: 12, personalization: 'list to follow' }] })).status).toBe(201)
})

test('Turnstile: refused, replayed, wrong host, wrong action, missing and down all open nothing', async () => {
  const t = setup()
  const post = (turnstileToken?: string) => t.call('/submissions', { method: 'POST', body: JSON.stringify({ turnstileToken }) })
  for (const bad of ['spent', 'wrong-host', 'wrong-action', undefined]) expect(await code(await post(bad)), String(bad)).toEqual([400, 'verification_failed'])
  expect(await code(await post('down'))).toEqual([503, 'verification_unavailable'])
  expect(t.n('inquiry_submissions')).toBe(0)
  // Without its secrets the route refuses rather than opening unverified.
  const noSecret = await app.request(`https://${HOST}/api/public/submissions`, { method: 'POST', body: '{"turnstileToken":"good"}' }, { ...t.env, TURNSTILE_SECRET: undefined })
  expect(await code(noSecret)).toEqual([503, 'intake_closed'])
})

test('the session token is the only key: stored hashed, absent or wrong refuses, and it stops working once expired', async () => {
  const t = setup()
  const token = await t.open()
  expect(t.n(`inquiry_submissions WHERE token_hash = '${token}'`)).toBe(0)
  expect(await code(await t.upload('y'.repeat(43)))).toEqual([401, 'session_invalid'])
  expect(await code(await t.call('/submissions/files', { method: 'POST', body: PNG as Uint8Array<ArrayBuffer> }))).toEqual([401, 'session_invalid'])
  t.expire()
  expect(await code(await t.upload(token))).toEqual([410, 'session_expired'])
  expect(await code(await t.submit(token))).toEqual([410, 'session_expired'])
})

test('file rules: type, purpose, size, and one session cannot touch another session\'s file', async () => {
  const t = setup()
  const token = await t.open()
  expect((await t.upload(token, HTML, { type: 'text/html' })).status).toBe(415)
  expect((await t.upload(token, SVG, { type: 'image/svg+xml', purpose: 'po' })).status).toBe(415) // a PO is never an SVG
  expect((await t.upload(token, new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]), { type: 'image/tiff' })).status).toBe(415)
  expect((await t.upload(token, SVG, { type: 'image/svg+xml' })).status).toBe(201)
  expect((await t.upload(token, PDF, { type: 'application/pdf', purpose: 'po' })).status).toBe(201)
  expect(await code(await t.upload(token, PNG, { length: 21 * 2 ** 20 }))).toEqual([413, 'file_too_large'])
  expect((await t.upload(token, PNG, { purpose: 'secret' })).status).toBe(400)
  // Refused uploads gave their reservation back, so they can't use up the session.
  expect(t.n("inquiry_files WHERE status IN ('reserved','stored')")).toBe(2)

  const ack = await (await t.upload(token)).json() as { id: string }
  const other = await t.open('203.0.113.2')
  expect((await t.call(`/submissions/files/${ack.id}`, { method: 'DELETE', headers: t.auth(other) })).status).toBe(404)
  expect((await t.call(`/submissions/files/${ack.id}`, { method: 'DELETE', headers: t.auth(token) })).status).toBe(200)
  expect(t.n(`inquiry_files WHERE id = '${ack.id}' AND status = 'failed'`)).toBe(1)
  expect(t.r2.objects.size).toBe(2)
})

test('rejected uploads never touch the daily budget, and one session cannot keep trying forever (Codex)', async () => {
  const t = setup()
  const token = await t.open()
  const refused = await Promise.all(Array.from({ length: SESSION_MAX_ATTEMPTS }, () => t.upload(token, HTML, { type: 'text/html', length: 20 * 2 ** 20 })))
  expect(refused.every((r) => r.status === 400 || r.status === 415)).toBe(true)
  expect(t.sqlite.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM intake_usage').get()).toEqual({ b: 0 })
  expect(await code(await t.upload(token))).toEqual([429, 'upload_limit']) // out of attempts
  const other = await t.open('203.0.113.77')
  expect((await t.upload(other)).status).toBe(201)
  expect(t.sqlite.prepare('SELECT SUM(bytes) AS b FROM intake_usage').get()).toEqual({ b: PNG.byteLength }) // stored bytes are charged
})

test('removing a file claims it first: a delete that loses to submit touches nothing, and R2 failing leaves it queued (Codex)', async () => {
  const t = setup()
  const token = await t.open()
  const del = (id: string, tok = token) => t.call(`/submissions/files/${id}`, { method: 'DELETE', headers: t.auth(tok) })
  const gone = await (await t.upload(token)).json() as { id: string }
  const flaky = await (await t.upload(token)).json() as { id: string }
  const kept = await (await t.upload(token)).json() as { id: string }

  const realDelete = t.r2.bucket.delete
  t.r2.bucket.delete = (async () => { throw new Error('R2 down') }) as never
  expect((await del(flaky.id)).status).toBe(200)
  t.r2.bucket.delete = realDelete
  expect(t.n(`inquiry_files WHERE id = '${flaky.id}' AND status = 'deleting'`)).toBe(1)

  // The claim happens with the object untouched, so submit can't link a file that is on its way out.
  let duringDelete = ''
  t.r2.bucket.delete = (async (k: string) => {
    duringDelete = (t.sqlite.prepare(`SELECT status FROM inquiry_files WHERE id = '${gone.id}'`).get() as { status: string }).status
    return realDelete(k)
  }) as never
  expect((await del(gone.id)).status).toBe(200)
  t.r2.bucket.delete = realDelete
  expect(duringDelete).toBe('deleting')

  expect((await t.submit(token)).status).toBe(201)
  const objects = t.r2.objects.size
  expect(await code(await del(kept.id))).toEqual([409, 'session_closed'])
  const { claimStored } = await import('../../worker/db/intake')
  const sid = (t.sqlite.prepare('SELECT id FROM inquiry_submissions').get() as { id: string }).id
  expect(await claimStored(t.db as never, kept.id, sid)).toBeNull() // a delete already past its checks loses too
  expect(t.r2.objects.size).toBe(objects)
  expect(t.n(`inquiry_files WHERE id = '${kept.id}' AND status = 'linked'`)).toBe(1)
})

test('the orphan sweep pages through the bucket and keeps its place across runs (Codex)', async () => {
  const t = setup()
  const old = new Date(Date.now() - 25 * 3_600_000)
  const token = await t.open()
  await t.upload(token)
  await t.submit(token)
  // Many objects a row still names sort first; the orphan sits past ten pages of them.
  const linked = t.sqlite.prepare('SELECT submission_id AS s FROM inquiry_files').get() as { s: string }
  const many = CLEANUP_BATCH * ORPHAN_PAGES_PER_RUN + 3
  t.sqlite.exec('BEGIN')
  for (let i = 0; i < many; i++) {
    const key = `inquiries/a-${String(i).padStart(5, '0')}`
    t.sqlite.prepare(`INSERT INTO inquiry_files (id, submission_id, r2_key, kind, status, bytes) VALUES (?, ?, ?, 'artwork', 'stored', 1)`).run(key, linked.s, key)
    await t.r2.bucket.put(key, JPEG)
    t.r2.uploaded.set(key, old)
  }
  t.sqlite.exec('COMMIT')
  await t.r2.bucket.put('inquiries/z-orphan', JPEG)
  t.r2.uploaded.set('inquiries/z-orphan', old)
  expect((await cleanupIntake(t.env, new Date())).orphans).toBe(0)
  expect(t.n("settings WHERE key = 'orphan_cursor'")).toBe(1)
  expect((await cleanupIntake(t.env, new Date())).orphans).toBe(1)
  expect(t.r2.objects.has('inquiries/z-orphan')).toBe(false)
  expect(t.n("settings WHERE key = 'orphan_cursor'")).toBe(0)
})

test('an R2 cursor that has gone stale resets instead of failing every future run', async () => {
  const t = setup()
  t.sqlite.exec("INSERT INTO settings (key, value) VALUES ('orphan_cursor', 'stale')")
  const list = t.r2.bucket.list
  t.r2.bucket.list = (async () => { throw new Error('invalid cursor') }) as never
  expect((await cleanupIntake(t.env, new Date())).orphans).toBe(0)
  t.r2.bucket.list = list
  expect(t.n("settings WHERE key = 'orphan_cursor'")).toBe(0)
})

test('only schools and organizations may attach a PO', async () => {
  const t = setup()
  const token = await t.open()
  await t.upload(token, PDF, { type: 'application/pdf', purpose: 'po' })
  expect(await code(await t.submit(token, { ...FORM, customerKind: 'individual' }))).toEqual([400, 'po_not_accepted'])
  expect((await t.submit(token)).status).toBe(201)
})

test('parallel uploads cannot pass the session\'s file cap', async () => {
  const t = setup()
  const token = await t.open()
  const results = await Promise.all(Array.from({ length: 12 }, () => t.upload(token)))
  expect(results.filter((r) => r.status === 201).length).toBe(SESSION_MAX_FILES)
  expect(results.filter((r) => r.status === 429).length).toBe(12 - SESSION_MAX_FILES)
  expect(t.r2.objects.size).toBe(SESSION_MAX_FILES)
})

test('the session byte cap and the outstanding-storage cap refuse before a byte is read', async () => {
  const t = setup()
  const token = await t.open()
  t.sqlite.exec(`INSERT INTO inquiry_submissions (id, token_hash, ip_hash, expires_at) VALUES ('big', 'h', 'i', '2999-01-01T00:00:00.000Z');
    INSERT INTO inquiry_files (id, submission_id, r2_key, kind, status, bytes) VALUES ('f', 'big', 'inquiries/big/f', 'artwork', 'deleting', ${OUTSTANDING_MAX_BYTES})`)
  const puts = t.r2.calls.filter(([op]) => op === 'put').length
  expect(await code(await t.upload(token))).toEqual([429, 'upload_limit']) // a deletion not yet confirmed still holds its bytes
  expect(t.r2.calls.filter(([op]) => op === 'put').length).toBe(puts)
  t.sqlite.exec("DELETE FROM inquiry_files WHERE id = 'f'")
  expect((await t.upload(token)).status).toBe(201)
})

test('flood: the per-IP ceiling, open-session cap and daily budget each stop new sessions without a word about which', async () => {
  const t = setup()
  const post = (ip: string) => t.call('/submissions', { method: 'POST', body: '{"turnstileToken":"good"}' }, ip)
  const replies = await Promise.all(Array.from({ length: IP_SESSIONS_PER_HOUR + 5 }, () => post('198.51.100.9')))
  expect(replies.filter((r) => r.status === 201).length).toBe(IP_SESSIONS_PER_HOUR)
  expect(await code(replies.find((r) => r.status === 429)!)).toEqual([429, 'busy'])
  expect((await post('198.51.100.10')).status).toBe(201) // a neighbouring address still gets in

  t.sqlite.exec(`INSERT INTO intake_usage (day, sessions) VALUES (date('now'), ${DAILY_MAX_SESSIONS}) ON CONFLICT (day) DO UPDATE SET sessions = excluded.sessions`)
  expect((await post('198.51.100.11')).status).toBe(429)
  t.sqlite.exec('UPDATE intake_usage SET sessions = 0')

  const values = Array.from({ length: OPEN_SESSIONS_MAX }, (_, i) => `('x${i}', 'th${i}', 'ip${i}', '2999-01-01T00:00:00.000Z')`).join(',')
  t.sqlite.exec(`INSERT INTO inquiry_submissions (id, token_hash, ip_hash, expires_at) VALUES ${values}`)
  expect((await post('198.51.100.12')).status).toBe(429)
  expect(JSON.stringify(t.sqlite.prepare('SELECT ip_hash FROM inquiry_submissions').all())).not.toContain('198.51')
})

test('submit is idempotent: a double-tap and parallel submits make one inquiry with one reference', async () => {
  const t = setup()
  const token = await t.open()
  await t.upload(token)
  const replies = await Promise.all([t.submit(token), t.submit(token), t.submit(token)])
  const refs = await Promise.all(replies.map(async (r) => ((await r.json()) as { ref: string }).ref))
  expect(new Set(refs).size).toBe(1)
  expect(t.n('inquiries')).toBe(1)
  expect(t.n("activity_log WHERE action = 'inquiry_received'")).toBe(1)
  expect(t.n("files WHERE r2_key LIKE 'inquiries/%'")).toBe(1)
  expect(((await (await t.submit(token, { nonsense: true })).json()) as { ref: string }).ref).toBe(refs[0]) // a retry isn't re-validated
})

test('submit vs settle: an upload in flight blocks submit; one that settles after the close never links', async () => {
  const t = setup()
  const token = await t.open()
  t.sqlite.exec(`INSERT INTO inquiry_files (id, submission_id, r2_key, kind, bytes) SELECT 'flight', id, 'inquiries/' || id || '/flight', 'artwork', 10 FROM inquiry_submissions`)
  expect(await code(await t.submit(token))).toEqual([409, 'uploads_in_progress'])
  expect(t.n('inquiries')).toBe(0)
  t.sqlite.exec("UPDATE inquiry_files SET status = 'failed' WHERE id = 'flight'")
  expect((await t.submit(token)).status).toBe(201)
  // After the close, an upload is refused, and a late settle (already past its checks) can't change the row.
  expect(await code(await t.upload(token))).toEqual([409, 'session_closed'])
  const { settleFile } = await import('../../worker/db/intake')
  t.sqlite.exec(`INSERT INTO inquiry_files (id, submission_id, r2_key, kind, bytes) SELECT 'late', id, 'inquiries/' || id || '/late', 'artwork', 10 FROM inquiry_submissions`)
  expect(await settleFile(t.db as never, 'late', { r2Key: 'k', mime: 'image/png', bytes: 10, sha256: 'x', filename: null }, '2026-01-01')).toBeNull()
  expect(t.n("intake_usage WHERE day = '2026-01-01'")).toBe(0)
  expect(t.n("inquiry_files WHERE id = 'late' AND status = 'reserved' AND file_id IS NULL")).toBe(1)
})

test('a body that lies about its length, or R2 failing, gives the reservation back or queues the delete; never a stuck row', async () => {
  const t = setup()
  const token = await t.open()
  expect((await t.upload(token, PNG, { length: PNG.byteLength + 5 })).status).toBe(400)
  expect(t.n("inquiry_files WHERE status = 'failed'")).toBe(1)
  expect(t.n("inquiry_files WHERE status = 'reserved'")).toBe(0)

  const put = t.r2.bucket.put
  t.r2.bucket.put = (async () => { throw new Error('R2 down') }) as never
  expect((await t.upload(token)).status).toBe(500)
  t.r2.bucket.put = put
  expect(t.n("inquiry_files WHERE status = 'reserved'")).toBe(0)
  expect(t.n("inquiry_files WHERE status = 'deleting'")).toBe(1) // ambiguous: bytes stay held until cron confirms
})

test('the off switch stops an existing session too; lifting it lets the same session finish', async () => {
  const t = setup()
  const token = await t.open()
  await t.upload(token)
  t.sqlite.exec("INSERT INTO settings (key, value) VALUES ('intake_closed', 'flood')")
  expect(await code(await t.upload(token))).toEqual([503, 'intake_closed'])
  expect(await code(await t.submit(token))).toEqual([503, 'intake_closed'])
  expect(t.n('inquiries')).toBe(0)
  t.sqlite.exec("DELETE FROM settings WHERE key = 'intake_closed'")
  expect((await t.submit(token)).status).toBe(201)
})

test('maintenance, cross-site and oversized JSON are refused on the public routes too', async () => {
  const t = setup()
  expect(await code(await t.call('/submissions', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{"turnstileToken":"good"}' }))).toEqual([403, 'cross_site_request'])
  expect((await t.call('/submissions', { method: 'POST', headers: { Origin: `https://${HOST}`, 'Sec-Fetch-Site': 'same-origin' }, body: '{"turnstileToken":"good"}' })).status).toBe(201)
  expect(await code(await t.call('/submissions', { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(70_000) }) }))).toEqual([413, 'body_too_large'])
  t.sqlite.exec("INSERT INTO settings (key, value) VALUES ('maintenance', 'backup')")
  expect(await code(await t.call('/submissions', { method: 'POST', body: '{}' }))).toEqual([503, 'maintenance'])
})

test('a filled honeypot looks accepted but lands as spam', async () => {
  const t = setup()
  const token = await t.open()
  const res = await t.submit(token, { ...FORM, website: 'http://spam.example' })
  expect(res.status).toBe(201)
  expect(t.sqlite.prepare('SELECT status, payload FROM inquiries').get()).toMatchObject({ status: 'spam' })
  expect((t.sqlite.prepare('SELECT payload FROM inquiries').get() as { payload: string }).payload).not.toContain('spam.example')
})

test('cleanup deletes abandoned uploads only: never a submitted file, and an expired session cannot submit once claimed', async () => {
  const t = setup()
  const kept = await t.open('203.0.113.3')
  await t.upload(kept)
  await t.submit(kept)
  const abandoned = await t.open('203.0.113.4')
  await t.upload(abandoned)
  const live = await t.open('203.0.113.5')
  await t.upload(live)
  expect(t.r2.objects.size).toBe(3)

  t.sqlite.exec(`DROP TRIGGER submissions_identity_fixed;
    UPDATE inquiry_submissions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE ip_hash = (SELECT ip_hash FROM inquiry_submissions WHERE status = 'submitted');
    UPDATE inquiry_submissions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id IN (SELECT id FROM inquiry_submissions WHERE status = 'open' ORDER BY rowid LIMIT 1)`)
  expect(await cleanupIntake(t.env, new Date())).toEqual({ deleted: 1, orphans: 0 })
  expect(t.r2.objects.size).toBe(2)
  expect(t.n("inquiry_files WHERE status = 'linked'")).toBe(1) // the submitted one, though long past its expiry
  expect(t.n("inquiry_files WHERE status = 'stored'")).toBe(1) // the live session's
  expect(t.n("inquiry_submissions WHERE status = 'expiring'")).toBe(0) // finished and forgotten
  expect(await code(await t.upload(abandoned))).toEqual([401, 'session_invalid'])
  expect((await t.submit(live)).status).toBe(201)
  await expect(async () => t.sqlite.exec("UPDATE inquiry_files SET status = 'deleting' WHERE status = 'linked'")).rejects.toThrow(/linked_fixed/)
})

test('settle vs cleanup: once claimed, a late settle loses, and an R2 failure keeps the row and the bytes held', async () => {
  const t = setup()
  const token = await t.open()
  const ack = await (await t.upload(token)).json() as { id: string }
  t.expire()
  const del = t.r2.bucket.delete
  t.r2.bucket.delete = (async () => { throw new Error('R2 down') }) as never
  await cleanupIntake(t.env, new Date())
  t.r2.bucket.delete = del
  expect(t.n(`inquiry_files WHERE id = '${ack.id}' AND status = 'deleting'`)).toBe(1)
  expect(await code(await t.submit(token))).toEqual([410, 'session_expired'])
  const { settleFile } = await import('../../worker/db/intake')
  expect(await settleFile(t.db as never, ack.id, { r2Key: 'k', mime: 'image/png', bytes: 1, sha256: 'x', filename: null }, '2026-01-01')).toBeNull()
  // The retry finishes the job.
  expect((await cleanupIntake(t.env, new Date())).deleted).toBe(1)
  expect(t.r2.objects.size).toBe(0)
  expect(t.n('inquiry_files')).toBe(0)
  expect(t.n('inquiry_submissions')).toBe(0)
})

test('orphans: only objects no row names, and only past the 24 h grace', async () => {
  const t = setup()
  const token = await t.open()
  await t.upload(token)
  const put = (k: string) => t.r2.bucket.put(k, JPEG)
  await put('inquiries/gone/old')
  await put('inquiries/gone/new')
  await put('orders/1/not-ours')
  const old = new Date(Date.now() - 25 * 3_600_000)
  t.r2.uploaded.set('inquiries/gone/old', old)
  t.r2.uploaded.set('orders/1/not-ours', old)
  for (const k of t.r2.objects.keys()) if (k.startsWith('inquiries/') && !k.includes('gone')) t.r2.uploaded.set(k, old) // a row names it: safe however old
  expect((await cleanupIntake(t.env, new Date())).orphans).toBe(1)
  expect([...t.r2.objects.keys()].filter((k) => k.includes('gone') || k.startsWith('orders'))).toEqual(['inquiries/gone/new', 'orders/1/not-ours'])
  expect(t.r2.objects.size).toBe(3)
})

test('cleanup stands down during a backup', async () => {
  const t = setup()
  t.sqlite.exec("INSERT INTO settings (key, value) VALUES ('maintenance', 'backup')")
  expect(await cleanupIntake(t.env, new Date())).toEqual({ skipped: true })
})

test('inquiries.status CHECK matches shared/enums.ts on the final schema, with the rebuild leaving no scaffolding', () => {
  const { sqlite } = createTestD1()
  const sql = (sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name = 'inquiries'").get() as { sql: string }).sql
  expect([...(/status IN \(([^)]*)\)/.exec(sql)?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1])).toEqual([...INQUIRY_STATUSES])
  expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '\\_m9%' ESCAPE '\\'").all()).toEqual([])
})

test('references avoid characters that get misread', () => {
  expect(newRef(new Uint8Array([0, 1, 8, 31, 32, 255]))).toBe('INQ-23AZ2Z')
})

test('staff file downloads still never serve an unsubmitted or inquiry-only file', async () => {
  const t = setup()
  const token = await t.open()
  await t.upload(token)
  await t.submit(token)
  const id = (t.sqlite.prepare("SELECT id FROM files WHERE r2_key LIKE 'inquiries/%'").get() as { id: number }).id
  const res = await app.request(`http://localhost/api/app/files/${id}`, {}, { ...t.env, DEV_AUTH_EMAIL: 'owner1@example.com' })
  expect(res.status).toBe(404)
})
