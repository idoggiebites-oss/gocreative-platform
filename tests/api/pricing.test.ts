// Pricing versions and estimates at the database: the workflow rules hold even if a route gets something wrong. Rates are test numbers only.
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { checksum, dumpTable, foreignKeyOrder, listTables, replaySql, restoreSql, type Exec, type Row } from '../../scripts/backup-lib.ts'
import * as db from '../../worker/db/pricing'
import { calculateEstimate, customerView, pricingConfigSchema, type PricingConfig } from '../../worker/domain/pricing/engine'
import { processClaimed } from '../../worker/inquiryDeletion'
import { createTestD1 } from './d1'
import { createTestR2 } from './r2'

const seed = readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8')
const config = (cost: number): PricingConfig => pricingConfigSchema.parse({ productCostCents: { tshirts: cost }, services: { dtg: { adjustmentBps: 0, pricing: { mode: 'markup', rateBps: 10000 }, sizeCostTiers: { medium: [{ minQty: 1, costCents: 200 }] } } } })
const REQUEST = { lines: [{ product: 'tshirts', method: 'dtg', quantity: 5, decorations: [{ size: 'medium' as const }] }] }

function setup() {
  const { db: d1, sqlite } = createTestD1()
  sqlite.exec(seed)
  const actor = (sqlite.prepare('SELECT id FROM users LIMIT 1').get() as { id: number }).id
  const n = (sql: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n
  const inquiry = (ref = 'INQ-AAAAAA') => {
    sqlite.prepare(`INSERT INTO inquiries (payload, contact_name, ref) VALUES ('{"lines":[]}', 'Pat', ?)`).run(ref)
    return (sqlite.prepare('SELECT id FROM inquiries WHERE ref = ?').get(ref) as { id: number }).id
  }
  const publish = async (cost: number, expectedActiveId: number | null) => {
    const c = config(cost)
    const existing = await db.getDraftPricing(d1 as never)
    const hash = (await db.saveDraft(d1 as never, { config: c, expectedHash: existing?.config_hash ?? null, actorId: actor, note: null }))!
    const draft = (await db.getDraftPricing(d1 as never))!
    expect(await db.publishDraft(d1 as never, { draftId: draft.id, draftHash: hash, expectedActiveId, actorId: actor })).toBe(true)
    return draft.id
  }
  return { sqlite, d1: d1 as never as D1Database, actor, n, inquiry, publish }
}

test('with nothing published there is no price: the engine says manual review, and nothing is seeded', () => {
  const t = setup()
  expect(t.n('pricing_versions')).toBe(0)
  expect(calculateEstimate(null, REQUEST).status).toBe('manual_review_required')
})

test('a draft affects nothing live until it is published; publishing replaces the active version in one step', async () => {
  const t = setup()
  const v1 = await t.publish(300, null)
  await db.saveDraft(t.d1, { config: config(900), expectedHash: null, actorId: t.actor, note: 'trial' })
  expect((await db.getActivePricing(t.d1))!.id).toBe(v1)
  expect(JSON.parse((await db.getActivePricing(t.d1))!.config).productCostCents.tshirts).toBe(300)
  const draft = (await db.getDraftPricing(t.d1))!
  expect(await db.publishDraft(t.d1, { draftId: draft.id, draftHash: draft.config_hash, expectedActiveId: v1, actorId: t.actor })).toBe(true)
  expect((await db.getActivePricing(t.d1))!.id).toBe(draft.id)
  expect((await db.getPricingVersion(t.d1, v1))!.status).toBe('retired')
  expect(t.n("pricing_versions WHERE status = 'active'")).toBe(1)
  expect(t.n("activity_log WHERE action = 'pricing_published'")).toBe(2)
})

test('publishing is bound to what was previewed: a draft edited afterwards, or a publish that got there first, changes nothing', async () => {
  const t = setup()
  const v1 = await t.publish(300, null)
  const hash = (await db.saveDraft(t.d1, { config: config(400), expectedHash: null, actorId: t.actor, note: null }))!
  const draft = (await db.getDraftPricing(t.d1))!
  // Someone edits the draft after this owner previewed it.
  const edited = (await db.saveDraft(t.d1, { config: config(999), expectedHash: hash, actorId: t.actor, note: null }))!
  expect(await db.publishDraft(t.d1, { draftId: draft.id, draftHash: hash, expectedActiveId: v1, actorId: t.actor })).toBe(false)
  expect((await db.getActivePricing(t.d1))!.id).toBe(v1)
  // A stale idea of what is active also changes nothing.
  expect(await db.publishDraft(t.d1, { draftId: draft.id, draftHash: edited, expectedActiveId: 12345, actorId: t.actor })).toBe(false)
  expect(await db.publishDraft(t.d1, { draftId: draft.id, draftHash: edited, expectedActiveId: null, actorId: t.actor })).toBe(false)
  expect((await db.getActivePricing(t.d1))!.id).toBe(v1)
  expect((await db.getPricingVersion(t.d1, v1))!.status).toBe('active')
  expect(t.n("activity_log WHERE action = 'pricing_published'")).toBe(1)
})

test('parallel publishes: exactly one wins, and there is always exactly one active version', async () => {
  const t = setup()
  const v1 = await t.publish(300, null)
  const hash = (await db.saveDraft(t.d1, { config: config(400), expectedHash: null, actorId: t.actor, note: null }))!
  const draft = (await db.getDraftPricing(t.d1))!
  const results = await Promise.all([1, 2, 3].map(() => db.publishDraft(t.d1, { draftId: draft.id, draftHash: hash, expectedActiveId: v1, actorId: t.actor })))
  expect(results.filter(Boolean)).toHaveLength(1)
  expect(t.n("pricing_versions WHERE status = 'active'")).toBe(1)
})

test('two people editing a draft: the second, working from an old copy, is refused', async () => {
  const t = setup()
  const first = (await db.saveDraft(t.d1, { config: config(1), expectedHash: null, actorId: t.actor, note: null }))!
  expect(await db.saveDraft(t.d1, { config: config(2), expectedHash: null, actorId: t.actor, note: null })).toBeNull()
  expect(await db.saveDraft(t.d1, { config: config(2), expectedHash: first, actorId: t.actor, note: null })).toBeTruthy()
  expect(await db.saveDraft(t.d1, { config: config(3), expectedHash: first, actorId: t.actor, note: null })).toBeNull()
  expect(t.n("pricing_versions WHERE status = 'draft'")).toBe(1)
})

test('what was published can never change; rollback publishes a copy as a new version', async () => {
  const t = setup()
  const v1 = await t.publish(300, null)
  const v2 = await t.publish(900, v1)
  for (const sql of [`UPDATE pricing_versions SET config = '{}' WHERE id = ${v1}`, `UPDATE pricing_versions SET status = 'active' WHERE id = ${v1}`, `UPDATE pricing_versions SET status = 'draft' WHERE id = ${v2}`, `DELETE FROM pricing_versions WHERE id = ${v1}`]) expect(() => t.sqlite.exec(sql), sql).toThrow(/pricing_published/)
  const old = (await db.getPricingVersion(t.d1, v1))!
  const hash = (await db.saveDraft(t.d1, { config: JSON.parse(old.config), expectedHash: null, actorId: t.actor, note: 'Back to v1', rollbackOf: v1 }))!
  const copy = (await db.getDraftPricing(t.d1))!
  expect(await db.publishDraft(t.d1, { draftId: copy.id, draftHash: hash, expectedActiveId: v2, actorId: t.actor })).toBe(true)
  const active = (await db.getActivePricing(t.d1))!
  expect(active.id).toBeGreaterThan(v2)
  expect(active.rollback_of).toBe(v1)
  expect(active.config_hash).toBe(old.config_hash)
  expect((await db.listPricingVersions(t.d1)).map((v) => v.status)).toEqual(['active', 'retired', 'retired'])
})

test('an estimate keeps its exact version and result: later prices never change it, and replaying it gives the same figure', async () => {
  const t = setup()
  const inquiry = t.inquiry()
  const v1 = await t.publish(300, null)
  const c1 = JSON.parse((await db.getActivePricing(t.d1))!.config) as PricingConfig
  const result = calculateEstimate(c1, REQUEST)
  const id = (await db.saveEstimate(t.d1, { inquiryId: inquiry, pricingVersionId: v1, analyzerVersion: null, factsSource: 'none', inputs: REQUEST, customerResult: customerView(result), result, createdBy: null }))!
  await t.publish(900, v1)
  const stored = (await db.listEstimates(t.d1, inquiry))[0]
  expect(stored.pricing_version_id).toBe(v1)
  expect(JSON.parse(stored.customer_result).totalCents).toBe(result.totalCents)
  // Replay from what was stored, through the version it names.
  const replay = calculateEstimate(JSON.parse((await db.getPricingVersion(t.d1, v1))!.config), JSON.parse(stored.inputs))
  expect(replay.totalCents).toBe(result.totalCents)
  // It can't be edited, even directly.
  expect(() => t.sqlite.exec(`UPDATE inquiry_estimates SET status = 'available' WHERE id = ${id}`)).toThrow(/estimates_no_update/)
  expect(() => t.sqlite.exec(`DELETE FROM inquiry_estimates WHERE id = ${id}`)).toThrow(/only_with_claim/)
})

test('an estimate is not a quote: storing one creates no quote and changes no order', async () => {
  const t = setup()
  const before = [t.n('quotes'), t.n('quote_items'), t.n('orders'), t.n('order_items')]
  const inquiry = t.inquiry()
  const v1 = await t.publish(300, null)
  const result = calculateEstimate(config(300), REQUEST)
  await db.saveEstimate(t.d1, { inquiryId: inquiry, pricingVersionId: v1, analyzerVersion: null, factsSource: 'none', inputs: REQUEST, customerResult: customerView(result), result, createdBy: null })
  expect([t.n('quotes'), t.n('quote_items'), t.n('orders'), t.n('order_items')]).toEqual(before)
})

test('customer output holds no cost or margin; internal output is a separate column', async () => {
  const t = setup()
  const inquiry = t.inquiry()
  const result = calculateEstimate(config(300), REQUEST)
  await db.saveEstimate(t.d1, { inquiryId: inquiry, pricingVersionId: null, analyzerVersion: null, factsSource: 'none', inputs: REQUEST, customerResult: customerView(result), result, createdBy: null })
  const e = (await db.listEstimates(t.d1, inquiry))[0]
  expect(e.customer_result).not.toMatch(/cost|margin/i)
  expect(JSON.parse(e.internal_result).internal.costCents).toBe(2500)
})

test('an override records what it was, what it became, why and who, and needs a reason', async () => {
  const t = setup()
  const inquiry = t.inquiry()
  const result = calculateEstimate(null, REQUEST)
  const e = (await db.saveEstimate(t.d1, { inquiryId: inquiry, pricingVersionId: null, analyzerVersion: 1, factsSource: 'customer_reported', inputs: REQUEST, customerResult: customerView(result), result, createdBy: null }))!
  await db.addEstimateOverride(t.d1, { estimateId: e, field: 'colors', original: '2', replacement: '3', reason: 'Underbase needed', actorId: t.actor })
  expect(t.sqlite.prepare('SELECT field, original, replacement, reason, actor_id AS a FROM estimate_overrides').get()).toEqual({ field: 'colors', original: '2', replacement: '3', reason: 'Underbase needed', a: t.actor })
  await expect(db.addEstimateOverride(t.d1, { estimateId: e, field: 'colors', original: '2', replacement: '3', reason: '   ', actorId: t.actor })).rejects.toThrow()
  expect(() => t.sqlite.exec('UPDATE estimate_overrides SET reason = \'x\'')).toThrow(/no_update/)
})

test('deleting an inquiry takes its estimates and overrides with it, live and on replay; versions stay', async () => {
  const t = setup()
  const inquiry = t.inquiry()
  const v1 = await t.publish(300, null)
  const result = calculateEstimate(config(300), REQUEST)
  const e = (await db.saveEstimate(t.d1, { inquiryId: inquiry, pricingVersionId: v1, analyzerVersion: null, factsSource: 'none', inputs: REQUEST, customerResult: customerView(result), result, createdBy: null }))!
  await db.addEstimateOverride(t.d1, { estimateId: e, field: 'colors', original: '2', replacement: '3', reason: 'Rosa called', actorId: t.actor })

  const exec: Exec = (sql) => t.sqlite.prepare(sql).all() as Row[]
  const order = await foreignKeyOrder(exec, await listTables(exec))
  const snapshot = await Promise.all(order.map(async (name) => ({ name, rows: await dumpTable(exec, name) })))

  t.sqlite.exec(`UPDATE inquiries SET deleting_at = '2030-01-01T00:00:00.000Z' WHERE id = ${inquiry}`)
  const r2 = createTestR2()
  expect(await processClaimed({ DB: t.d1, FILES: r2.bucket } as never, 'owner', t.actor)).toBe(1)
  expect(t.n('inquiry_estimates')).toBe(0)
  expect(t.n('estimate_overrides')).toBe(0)
  expect(t.n('pricing_versions')).toBe(1)
  const entry = JSON.parse(new TextDecoder().decode([...r2.objects.values()][0].bytes))

  const target = createTestD1()
  const texec: Exec = (sql) => target.sqlite.prepare(sql).all() as Row[]
  const triggers = texec("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name") as { name: string; sql: string }[]
  target.sqlite.exec('BEGIN'); target.sqlite.exec(restoreSql(snapshot, triggers)); target.sqlite.exec('COMMIT')
  for (const x of snapshot) expect(checksum(await dumpTable(texec, x.name)), x.name).toBe(checksum(x.rows))
  expect(texec('SELECT id FROM inquiry_estimates')).toHaveLength(1)
  target.sqlite.exec('BEGIN'); target.sqlite.exec(replaySql([entry], triggers)); target.sqlite.exec('COMMIT')
  expect(texec('SELECT id FROM inquiry_estimates')).toEqual([])
  expect(texec('SELECT id FROM estimate_overrides')).toEqual([])
  expect(texec('PRAGMA foreign_key_check')).toEqual([])
})
