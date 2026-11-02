// Pricing Management: owner only, every route, enforced here and not by hiding a link. Costs and margins appear on these routes and nowhere else.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { ApiErrorCode } from '../../shared/api'
import { requireRole, type AppEnv } from '../auth'
import * as db from '../db/pricing'
import { calculateEstimate, customerView, estimateRequestSchema, parseConfig, pricingConfigSchema } from '../domain/pricing/engine'

const fail = (c: Context, status: 400 | 404 | 409, code: ApiErrorCode, error: string) => c.json({ error, code }, status)
const json = (c: Context) => c.req.json().catch(() => null)
const invalid = (c: Context) => fail(c, 400, 'pricing_invalid', 'Pricing values are not valid')
const changed = (c: Context) => fail(c, 409, 'pricing_changed', 'Prices changed, reload and retry')
const parseStored = parseConfig
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const view = (r: ReturnType<typeof calculateEstimate>) => ({
  ...customerView(r), status: r.status, reasons: r.reasons, costCents: r.status === 'manual_review_required' ? null : r.internal.costCents, marginBps: r.internal.marginBps,
  lines: r.lines,
})

export function pricingRoutes() {
  return new Hono<AppEnv>()
    .use('/pricing/*', requireRole('owner'))
    .use('/pricing', requireRole('owner'))
    .get('/pricing', async (c) => {
      const [active, draft, versions] = await Promise.all([db.getActivePricing(c.env.DB), db.getDraftPricing(c.env.DB), db.listPricingVersions(c.env.DB)])
      return c.json({
        active: active && { id: active.id, hash: active.config_hash, config: parseStored(active.config) },
        draft: draft && { id: draft.id, hash: draft.config_hash, config: parseStored(draft.config), rollbackOf: draft.rollback_of, note: draft.note },
        versions: versions.map((v) => ({ id: v.id, status: v.status, note: v.note, rollbackOf: v.rollback_of, createdAt: v.created_at, publishedAt: v.published_at, publishedBy: v.published_by_name })),
      })
    })
    .put('/pricing/draft', async (c) => {
      const b = z.object({ config: pricingConfigSchema, expectedHash: hash.nullable(), note: z.string().trim().max(500).nullish() }).strict().safeParse(await json(c))
      if (!b.success) return invalid(c)
      const saved = await db.saveDraft(c.env.DB, { config: b.data.config, expectedHash: b.data.expectedHash, actorId: c.get('user').id, note: b.data.note ?? null })
      return saved ? c.json({ hash: saved }) : changed(c)
    })
    .delete('/pricing/draft', async (c) => {
      const b = z.object({ hash }).strict().safeParse(await json(c))
      if (!b.success) return invalid(c)
      return (await db.discardDraft(c.env.DB, b.data.hash)) ? c.json({ ok: true }) : changed(c)
    })
    // Compares the published version with a proposal. It writes nothing, so it can't affect a customer's price.
    .post('/pricing/simulate', async (c) => {
      const b = z.object({ request: estimateRequestSchema, config: pricingConfigSchema.nullable() }).strict().safeParse(await json(c))
      if (!b.success) return invalid(c)
      const active = await db.getActivePricing(c.env.DB)
      const request = b.data.request
      const current = calculateEstimate(active ? parseStored(active.config) : null, request)
      const proposed = calculateEstimate(b.data.config, request)
      return c.json({
        current: view(current), proposed: view(proposed),
        differenceCents: current.totalCents !== null && proposed.totalCents !== null ? proposed.totalCents - current.totalCents : null,
      })
    })
    .post('/pricing/publish', async (c) => {
      const b = z.object({ draftId: z.number().int().positive(), draftHash: hash, expectedActiveId: z.number().int().positive().nullable() }).strict().safeParse(await json(c))
      if (!b.success) return invalid(c)
      const draft = await db.getPricingVersion(c.env.DB, b.data.draftId)
      if (draft?.status === 'draft' && !parseStored(draft.config)) return invalid(c) // never publish what the engine can't read
      const ok = await db.publishDraft(c.env.DB, { ...b.data, actorId: c.get('user').id })
      return ok ? c.json({ ok: true }) : changed(c)
    })
    // Rollback is a copy into the draft, then an ordinary publish, so history only ever grows.
    .post('/pricing/versions/:id/restore', async (c) => {
      const id = z.coerce.number().int().positive().safeParse(c.req.param('id'))
      const b = z.object({ expectedHash: hash.nullable() }).strict().safeParse(await json(c))
      if (!id.success || !b.success) return invalid(c)
      const source = await db.getPricingVersion(c.env.DB, id.data)
      const config = source && source.status !== 'draft' ? parseStored(source.config) : null
      if (!config) return fail(c, 404, 'not_found', 'Version not found')
      const saved = await db.saveDraft(c.env.DB, { config, expectedHash: b.data.expectedHash, actorId: c.get('user').id, note: null, rollbackOf: source!.id })
      return saved ? c.json({ hash: saved }) : changed(c)
    })
}
