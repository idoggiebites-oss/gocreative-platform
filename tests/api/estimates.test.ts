// E3 over the real routes. Rates are test numbers only. Customer prices are off unless a test says so, as in production.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ANALYZER_VERSION } from '../../shared/artworkAnalysis'
import { business } from '../../shared/business'
import { calculateEstimate, parseConfig } from '../../worker/domain/pricing/engine'
import { SESSION_MAX_ESTIMATES } from '../../worker/domain/intake'
import { app } from '../../worker/index'
import { createTestD1 } from './d1'
import { PNG, createTestR2 } from './r2'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
const HOST = 'localhost'
const OWNER = 'owner1@example.com'
const STAFF = 'staff9@example.com'
const SCREEN = { adjustmentBps: 0, pricing: { mode: 'markup', rateBps: 10000 }, colorCostTiers: [{ minQty: 1, costCents: 100 }], screenFee: { sellCents: 1000, costCents: 400 } }
const CONFIG = { productCostCents: { tshirts: 300 }, services: { screen: SCREEN } }
const report = (colors: number | null, over: object = {}) => ({ analyzerVersion: ANALYZER_VERSION, estimatedInkColors: colors, confidence: 'high', needsManualReview: colors === null, flags: [], ...over })
const FORM = { customerKind: 'individual', contactName: 'Pat Doe', contactEmail: 'pat@example.com' }

function setup(on = true) {
  const { db, sqlite } = createTestD1()
  sqlite.exec(seed)
  sqlite.exec("DELETE FROM settings WHERE key = 'intake_closed'")
  sqlite.exec(`INSERT INTO users (email, name, role, active) VALUES ('${STAFF}', 'Staff', 'staff', 1)`)
  const r2 = createTestR2()
  const env = { DB: db, FILES: r2.bucket, IP_HASH_SALT: 'salt', DEV_TURNSTILE_PASS: '1', ...(on ? { DEV_CUSTOMER_ESTIMATES: '1' } : {}) } as unknown as Env
  const pub = (path: string, init: RequestInit = {}) => app.request(`http://${HOST}/api/public${path}`, { ...init, headers: { 'CF-Connecting-IP': '203.0.113.1', ...init.headers } }, env)
  const staff = (method: string, path: string, body?: unknown, as = OWNER) => app.request(`http://${HOST}/api/app${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { ...env, DEV_AUTH_EMAIL: as } as Env)
  const open = async () => ((await (await pub('/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnstileToken: 'x' }) })).json()) as { token: string }).token
  const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })
  const upload = async (token: string) => ((await (await pub('/submissions/files', { method: 'POST', body: PNG as Uint8Array<ArrayBuffer>, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'X-File-Purpose': 'artwork', 'Content-Length': String(PNG.byteLength) } })).json()) as { id: string }).id
  const preview = (token: string, body: unknown) => pub('/estimate', { method: 'POST', headers: auth(token), body: JSON.stringify(body) })
  const submit = (token: string, body: unknown) => pub('/submissions/submit', { method: 'POST', headers: auth(token), body: JSON.stringify({ ...FORM, ...(body as object) }) })
  const publish = async (config: object) => {
    const before = (await (await staff('GET', '/pricing')).json()) as { active: { id: number } | null; draft: { hash: string } | null }
    await staff('PUT', '/pricing/draft', { config, expectedHash: before.draft?.hash ?? null })
    const d = ((await (await staff('GET', '/pricing')).json()) as { draft: { id: number; hash: string } }).draft
    expect((await staff('POST', '/pricing/publish', { draftId: d.id, draftHash: d.hash, expectedActiveId: before.active?.id ?? null })).status).toBe(200)
    return d.id
  }
  const n = (sql: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n
  const estimates = (id: number, as = OWNER) => staff('GET', `/inquiries/${id}/estimates`, undefined, as)
  return { sqlite, db, env, pub, staff, open, upload, preview, submit, publish, n, estimates }
}
const line = (artwork: string | undefined, quantity = 10) => ({ product: 'tshirts', method: 'screen', quantity, prints: [{ location: 'front', artwork }] })
const inquiryId = (t: ReturnType<typeof setup>) => (t.sqlite.prepare('SELECT id FROM inquiries ORDER BY id DESC LIMIT 1').get() as { id: number }).id

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response('{}'))) })
afterEach(() => vi.unstubAllGlobals())

test('as shipped, customer prices are off: the flag is false in the code', () => {
  expect(business.storefront.customerEstimates).toBe(false)
})

test('off: published rates and an honest report still give the customer manual review, and the local override is ignored off localhost', async () => {
  const t = setup(false)
  await t.publish(CONFIG)
  expect(await (await t.pub('/status')).json()).toMatchObject({ estimates: false })
  const token = await t.open()
  const id = await t.upload(token)
  const body = { lines: [line(id)], reports: { [id]: report(2) } }
  expect((await (await t.preview(token, body)).json() as { estimate: unknown }).estimate).toEqual({ status: 'manual_review_required', totalCents: null, assumptions: [] })
  expect(t.sqlite.prepare('SELECT estimate_calls AS n FROM inquiry_submissions').get()).toEqual({ n: 0 })
  const res = await t.submit(token, body)
  expect(((await res.json()) as { estimate: { totalCents: null } }).estimate.totalCents).toBeNull()
  // Nothing the browser said was used, so nothing is labelled as the customer's.
  const row = t.sqlite.prepare('SELECT facts_source, customer_result FROM inquiry_estimates').get() as { facts_source: string; customer_result: string }
  expect(row.facts_source).toBe('none')
  expect(JSON.parse(row.customer_result).totalCents).toBeNull()
  const remote = await app.request('https://shop.example/api/public/status', {}, { DB: t.db, DEV_CUSTOMER_ESTIMATES: '1' } as unknown as Env)
  expect(await remote.json()).toMatchObject({ estimates: false })
})

test('on but nothing published: manual review, and no rate is ever zero', async () => {
  const t = setup()
  expect(await (await t.pub('/status')).json()).toMatchObject({ estimates: false })
  const token = await t.open()
  const id = await t.upload(token)
  const r = await (await t.preview(token, { lines: [line(id)], reports: { [id]: report(2) } })).json() as { estimate: { totalCents: null } }
  expect(r.estimate.totalCents).toBeNull()
  await t.submit(token, { lines: [line(id)], reports: { [id]: report(2) } })
  const row = t.sqlite.prepare('SELECT status, pricing_version_id, internal_result FROM inquiry_estimates').get() as { status: string; pricing_version_id: null; internal_result: string }
  expect(row).toMatchObject({ status: 'manual_review_required', pricing_version_id: null })
  expect(JSON.parse(row.internal_result).totalCents).toBeNull()
})

test('on and published: the server prices it; a browser total, cost or color count in the body is refused', async () => {
  const t = setup()
  await t.publish(CONFIG)
  expect(await (await t.pub('/status')).json()).toMatchObject({ estimates: true })
  const token = await t.open()
  const id = await t.upload(token)
  const body = { lines: [line(id)], reports: { [id]: report(2) } }
  const res = await t.preview(token, body)
  const text = await res.text()
  // (300 + 2 × 100) × 2 = 1000 a piece × 10, plus two screens at 1000
  expect(JSON.parse(text).estimate).toMatchObject({ status: 'assumption_based', totalCents: 12000 })
  expect(text).not.toMatch(/cost|margin|rateBps|internal|reason/i)
  for (const bad of [{ ...body, totalCents: 1 }, { lines: [{ ...line(id), unitPriceCents: 1 }] }, { lines: [{ ...line(id), colors: 1 }] }, { lines: [{ ...line(id), prints: [{ location: 'front', artwork: id, colors: 1 }] }] }, { lines: [{ ...line(id), prints: [{ location: 'nowhere', artwork: id }] }] }, { lines: [line(id)], reports: { [id]: { ...report(2), secret: 1 } } }]) {
    expect((await t.preview(token, bad)).status).toBe(400)
    expect((await t.submit(token, bad)).status).toBe(400)
  }
  expect(t.n('inquiries')).toBe(0)
  const sent = await t.submit(token, body)
  expect(sent.status).toBe(201)
  expect(((await sent.json()) as { estimate: { totalCents: number } }).estimate.totalCents).toBe(12000)
  const row = t.sqlite.prepare('SELECT facts_source, created_by, analyzer_version FROM inquiry_estimates').get()
  expect(row).toEqual({ facts_source: 'customer_reported', created_by: null, analyzer_version: ANALYZER_VERSION })
})

test('no defensible count means manual review: gradients, photos, transparency, low confidence, an old analyzer, a missing or foreign file', async () => {
  const t = setup()
  await t.publish(CONFIG)
  const other = await t.open()
  const foreign = await t.upload(other)
  const token = await t.open()
  const id = await t.upload(token)
  const cases: [unknown, object][] = [
    [line(id), { [id]: report(2, { flags: ['gradient'] }) }],
    [line(id), { [id]: report(2, { flags: ['photographic'] }) }],
    [line(id), { [id]: report(2, { flags: ['partly_transparent'] }) }],
    [line(id), { [id]: report(2, { confidence: 'low' }) }],
    [line(id), { [id]: report(2, { needsManualReview: true }) }],
    [line(id), { [id]: report(null) }],
    [line(id), { [id]: report(0) }],
    [line(id), { [id]: report(2, { analyzerVersion: ANALYZER_VERSION + 1 }) }],
    [line(id), {}],
    [line(undefined), { [id]: report(2) }],
    [line(foreign), { [foreign]: report(2) }],
    [{ product: 'tshirts', method: 'help', quantity: 10 }, {}],
    [{ product: 'tshirts', method: 'screen', quantity: 10 }, {}],
    [{ product: 'tshirts', method: 'embroidery', quantity: 10, prints: [{ location: 'front', artwork: id }] }, { [id]: report(2) }],
    [{ product: 'trophies', method: 'laser_engrave', quantity: 10 }, {}],
    [{ product: 'hoodies', method: 'screen', quantity: 10, prints: [{ location: 'front', artwork: id }] }, { [id]: report(2) }],
  ]
  for (const [l, reports] of cases) {
    const r = await (await t.preview(token, { lines: [l], reports })).json() as { estimate: { status: string; totalCents: null; assumptions: string[] } }
    expect(r.estimate, JSON.stringify(l)).toEqual({ status: 'manual_review_required', totalCents: null, assumptions: [] })
  }
})

test('a link to another session\'s file is never stored, and does not resolve for staff', async () => {
  const t = setup()
  await t.publish(CONFIG)
  const other = await t.open()
  const foreign = await t.upload(other)
  const token = await t.open()
  await t.submit(token, { lines: [line(foreign)], reports: { [foreign]: report(1) } })
  const payload = (t.sqlite.prepare('SELECT payload FROM inquiries').get() as { payload: string }).payload
  expect(payload).not.toContain(foreign)
  expect((t.sqlite.prepare('SELECT inputs FROM inquiry_estimates').get() as { inputs: string }).inputs).not.toContain(foreign)
})

test('the session quota is atomic, and a spent quota never blocks sending', async () => {
  const t = setup()
  await t.publish(CONFIG)
  const token = await t.open()
  const id = await t.upload(token)
  const body = { lines: [line(id)], reports: { [id]: report(2) } }
  const results = await Promise.all(Array.from({ length: SESSION_MAX_ESTIMATES + 5 }, () => t.preview(token, body)))
  expect(results.filter((r) => r.status === 200)).toHaveLength(SESSION_MAX_ESTIMATES)
  expect(results.filter((r) => r.status === 429)).toHaveLength(5)
  const sent = await t.submit(token, body)
  expect(sent.status).toBe(201)
  expect((t.sqlite.prepare('SELECT estimate_calls AS n FROM inquiry_submissions WHERE status = ?').get('submitted') as { n: number }).n).toBe(SESSION_MAX_ESTIMATES + 1)
})

test('a repeated submit gets the same reference and the same figure, with one estimate, even after prices change', async () => {
  const t = setup()
  await t.publish(CONFIG)
  const token = await t.open()
  const id = await t.upload(token)
  const body = { lines: [line(id)], reports: { [id]: report(2) } }
  const a = await (await t.submit(token, body)).json() as { ref: string; estimate: { totalCents: number } }
  await t.publish({ ...CONFIG, productCostCents: { tshirts: 900 } })
  const b = await (await t.submit(token, { lines: [line(id, 500)] })).json() as { ref: string; estimate: { totalCents: number } }
  expect(b).toEqual(a)
  const both = await Promise.all([t.submit(token, body), t.submit(token, body)])
  for (const r of both) expect(await r.json()).toEqual(a)
  expect(t.n('inquiry_estimates')).toBe(1)
})

test('prices published between preview and submit: the stored figure and version are the new ones, the customer is told, and the old version stays readable', async () => {
  const t = setup()
  const v1 = await t.publish(CONFIG)
  const token = await t.open()
  const id = await t.upload(token)
  const body = { lines: [line(id)], reports: { [id]: report(2) } }
  expect((await (await t.preview(token, body)).json() as { estimate: { totalCents: number } }).estimate.totalCents).toBe(12000)
  const v2 = await t.publish({ ...CONFIG, productCostCents: { tshirts: 400 } })
  expect(v2).not.toBe(v1)
  const sent = await (await t.submit(token, body)).json() as { estimate: { totalCents: number } }
  expect(sent.estimate.totalCents).toBe(14000)
  const row = t.sqlite.prepare('SELECT pricing_version_id, inputs, internal_result FROM inquiry_estimates').get() as { pricing_version_id: number; inputs: string; internal_result: string }
  expect(row.pricing_version_id).toBe(v2)
  // Reproducible: stored inputs plus the stored version give the stored figure.
  const config = (t.sqlite.prepare('SELECT config FROM pricing_versions WHERE id = ?').get(v2) as { config: string }).config
  expect(calculateEstimate(parseConfig(config), JSON.parse(row.inputs).request).totalCents).toBe(JSON.parse(row.internal_result).totalCents)
  // A later publish leaves it alone.
  await t.publish({ ...CONFIG, productCostCents: { tshirts: 999 } })
  expect((t.sqlite.prepare('SELECT pricing_version_id FROM inquiry_estimates').get() as { pricing_version_id: number }).pricing_version_id).toBe(v2)
})

async function submitted(t: ReturnType<typeof setup>, colors = 2) {
  const token = await t.open()
  const id = await t.upload(token)
  await t.submit(token, { lines: [line(id)], reports: { [id]: report(colors) } })
  const inquiry = inquiryId(t)
  const data = await (await t.estimates(inquiry)).json() as { estimates: { id: number; status: string; totalCents: number | null; factsSource: string; overrides: unknown[]; shownToCustomer: unknown; reanalysis: unknown[]; internal?: unknown }[]; seed: { method: string; decorations: { location: string | null; size: null; colors: number | null; complexity: null; machineMinutes: null; fileId: number | null }[] }[]; artworkFiles: { id: number }[] }
  return { inquiry, data, fileId: data.artworkFiles[0].id }
}
const reviewBody = (x: Awaited<ReturnType<typeof submitted>>, colors: number | null, o: object = {}, found: number | null = colors) => ({
  basedOn: x.data.estimates.at(-1)!.id, verified: true, reason: null,
  reanalysis: [{ fileId: x.fileId, report: report(found), refused: null }],
  lines: [{ method: 'screen', decorations: [{ ...x.data.seed[0].decorations[0], colors }] }], ...o,
})

test('staff see selling figures and no cost or margin; owners see both; a margin refusal doesn\'t reveal itself to staff', async () => {
  const t = setup()
  await t.publish({ ...CONFIG, minMarginBps: 9000 })
  const x = await submitted(t)
  const owner = await (await t.estimates(x.inquiry)).text()
  expect(owner).toMatch(/below the minimum margin/)
  const staff = await (await t.estimates(x.inquiry, STAFF)).text()
  expect(staff).not.toMatch(/margin|costCents|internal|rateBps/i)
  await t.publish(CONFIG)
  const y = await submitted(t)
  const seen = JSON.parse(await (await t.estimates(y.inquiry, STAFF)).text()) as { estimates: { totalCents: number; internal?: unknown }[] }
  expect(seen.estimates[0].totalCents).toBe(12000)
  expect(seen.estimates[0].internal).toBeUndefined()
  expect((JSON.parse(await (await t.estimates(y.inquiry)).text()) as { estimates: { internal: unknown }[] }).estimates[0].internal).toMatchObject({ costCents: expect.any(Number), marginBps: expect.any(Number) })
})

test('staff review: a new row labelled staff_reviewed; the customer\'s row, orders and quotes do not change; a changed count needs a reason and is audited', async () => {
  const t = setup()
  await t.publish(CONFIG)
  const x = await submitted(t)
  const customerRow = t.sqlite.prepare('SELECT * FROM inquiry_estimates').get()
  const counts = ['orders', 'order_items', 'quotes', 'quote_items'].map((n) => t.n(n))
  const noReason = await t.staff('POST', `/inquiries/${x.inquiry}/estimates/review`, reviewBody(x, 3, {}, 2), STAFF)
  expect(noReason.status).toBe(400)
  expect(((await noReason.json()) as { code: string }).code).toBe('estimate_reason_required')
  expect(t.n('inquiry_estimates')).toBe(1)
  const ok = await t.staff('POST', `/inquiries/${x.inquiry}/estimates/review`, reviewBody(x, 3, { reason: 'Customer asked for a third color' }, 2), STAFF)
  expect(ok.status).toBe(201)
  expect(t.sqlite.prepare('SELECT * FROM inquiry_estimates ORDER BY id LIMIT 1').get()).toEqual(customerRow)
  const after = await (await t.estimates(x.inquiry, STAFF)).json() as { estimates: { factsSource: string; totalCents: number; overrides: { field: string; original: string; replacement: string; reason: string; by: string }[]; shownToCustomer: unknown }[] }
  const latest = after.estimates[1]
  expect(latest.factsSource).toBe('staff_reviewed')
  expect(latest.totalCents).toBe(15000) // (300 + 3 × 100) × 2 × 10, plus three screens at 1000
  expect(latest.shownToCustomer).toBeNull()
  expect(latest.overrides).toEqual([expect.objectContaining({ field: 'line1.print1.colors', original: '2', replacement: '3', reason: 'Customer asked for a third color', by: 'Staff' })])
  expect(['orders', 'order_items', 'quotes', 'quote_items'].map((n) => t.n(n))).toEqual(counts)
  // The audit trail outlives retention, so counts only.
  const audit = t.sqlite.prepare("SELECT after FROM activity_log WHERE action = 'estimate_reviewed'").get() as { after: string }
  expect(audit.after).not.toMatch(/third color|"3"/)
})

test('accepting what the stored file shows is not an override, even when the customer reported something else', async () => {
  const t = setup()
  await t.publish(CONFIG)
  const x = await submitted(t, 1)
  const res = await t.staff('POST', `/inquiries/${x.inquiry}/estimates/review`, reviewBody(x, 2))
  expect(res.status).toBe(201)
  expect(t.n('estimate_overrides')).toBe(0)
})

test('where the stored file gives no count, setting one is an override with a reason; leaving it blank is manual review', async () => {
  const t = setup()
  await t.publish(CONFIG)
  const x = await submitted(t)
  const refused = (colors: number | null, o: object = {}) => ({ ...reviewBody(x, colors, o), reanalysis: [{ fileId: x.fileId, report: null, refused: 'unsupported' }] })
  expect((await t.staff('POST', `/inquiries/${x.inquiry}/estimates/review`, refused(null))).status).toBe(201)
  let d = await (await t.estimates(x.inquiry)).json() as { estimates: { id: number; status: string; totalCents: null | number }[] }
  expect(d.estimates.at(-1)).toMatchObject({ status: 'manual_review_required', totalCents: null })
  const next = { ...refused(2, { reason: 'Counted by hand from the file' }), basedOn: d.estimates.at(-1)!.id }
  expect((await t.staff('POST', `/inquiries/${x.inquiry}/estimates/review`, next)).status).toBe(201)
  d = await (await t.estimates(x.inquiry)).json() as typeof d
  expect(d.estimates.at(-1)!.totalCents).toBe(12000)
  expect(t.n("estimate_overrides WHERE field = 'line1.print1.colors' AND original IS NULL AND replacement = '2'")).toBe(1)
})

test('review refuses: unverified, a file not re-analyzed, another inquiry\'s file, tampered product or quantity, a stale screen; concurrent reviews write one row', async () => {
  const t = setup()
  await t.publish(CONFIG)
  const other = await submitted(t)
  const x = await submitted(t)
  const post = (b: object) => t.staff('POST', `/inquiries/${x.inquiry}/estimates/review`, b)
  const good = reviewBody(x, 2)
  expect((await post({ ...good, verified: false })).status).toBe(400)
  expect((await post({ ...good, reanalysis: [] })).status).toBe(400)
  expect((await post({ ...good, reanalysis: [{ fileId: other.fileId, report: report(2), refused: null }] })).status).toBe(400)
  expect((await post({ ...good, reanalysis: [{ fileId: x.fileId, report: report(2), refused: 'unsupported' }] })).status).toBe(400)
  expect((await post({ ...good, lines: [{ method: 'screen', decorations: [{ ...good.lines[0].decorations[0], fileId: other.fileId }] }] })).status).toBe(400)
  expect((await post({ ...good, lines: [{ ...good.lines[0], quantity: 1 }] })).status).toBe(400)
  expect((await post({ ...good, lines: [{ ...good.lines[0], product: 'hats' }] })).status).toBe(400)
  expect((await post({ ...good, lines: [good.lines[0], good.lines[0]] })).status).toBe(400)
  expect((await post({ ...good, basedOn: 999 })).status).toBe(409)
  const before = t.n('inquiry_estimates')
  const raced = await Promise.all([post(good), post(good), post(good)])
  expect(raced.map((r) => r.status).sort()).toEqual([201, 409, 409])
  expect(t.n('inquiry_estimates')).toBe(before + 1)
  expect(t.n("activity_log WHERE action = 'estimate_reviewed'")).toBe(1)
})

test('review uses the published version, never a draft', async () => {
  const t = setup()
  const v1 = await t.publish(CONFIG)
  const x = await submitted(t)
  await t.staff('PUT', '/pricing/draft', { config: { ...CONFIG, productCostCents: { tshirts: 9000 } }, expectedHash: null })
  expect((await t.staff('POST', `/inquiries/${x.inquiry}/estimates/review`, reviewBody(x, 2))).status).toBe(201)
  const d = await (await t.estimates(x.inquiry)).json() as { estimates: { totalCents: number; pricingVersionId: number }[] }
  expect(d.estimates.at(-1)).toMatchObject({ totalCents: 12000, pricingVersionId: v1 })
})

test('converting never reads an estimate: items stay at zero with no quote, and prints reach the item', async () => {
  const t = setup()
  await t.publish(CONFIG)
  const x = await submitted(t)
  expect((await t.staff('POST', `/inquiries/${x.inquiry}/estimates/review`, reviewBody(x, 2))).status).toBe(201)
  const quotes = t.n('quotes')
  const res = await t.staff('POST', `/inquiries/${x.inquiry}/convert`, { expectedVersion: ((await (await t.staff('GET', `/inquiries/${x.inquiry}`)).json()) as { version: number }).version, title: 'Job', dueDate: null, artworkRequired: true, customer: { new: { name: 'Pat', kind: 'individual', organization: null } } })
  expect(res.status).toBe(201)
  const item = t.sqlite.prepare('SELECT unit_price_cents AS price, description FROM order_items ORDER BY id DESC LIMIT 1').get() as { price: number; description: string }
  expect(item.price).toBe(0)
  expect(item.description).toContain('Full front')
  expect(t.n('quotes')).toBe(quotes)
  const o = t.sqlite.prepare("SELECT production_status FROM orders ORDER BY id DESC LIMIT 1").get() as { production_status: string }
  expect(o.production_status).not.toMatch(/in_production|printing|running/)
})

test('routes exist only behind sign-in, and an old request with bad print details stays readable', async () => {
  const t = setup()
  await t.publish(CONFIG)
  const x = await submitted(t)
  const anon = await app.request(`https://shop.example/api/app/inquiries/${x.inquiry}/estimates`, {}, { DB: t.db, ACCESS_AUD: 'a', ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com' } as unknown as Env)
  expect(anon.status).toBe(401)
  expect((await t.pub(`/estimates`)).status).toBe(404)
  t.sqlite.exec(`INSERT INTO inquiries (payload, contact_name, status) VALUES ('{"lines":[{"product":"gone","method":"screen","quantity":2,"prints":"nonsense"}]}', 'Old', 'new')`)
  const id = inquiryId(t)
  const detail = await (await t.staff('GET', `/inquiries/${id}`)).json() as { lines: { prints: unknown[] }[]; convertible: boolean }
  expect(detail.convertible).toBe(true)
  expect(detail.lines[0].prints).toEqual([])
  const e = await (await t.estimates(id)).json() as { estimates: unknown[]; seed: { decorations: unknown[] }[] }
  expect(e.estimates).toEqual([])
  expect(e.seed[0].decorations).toEqual([])
})

