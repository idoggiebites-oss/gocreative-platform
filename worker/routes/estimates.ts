// Preliminary estimates on the staff side. Staff see selling figures and may correct the facts; costs and margins are added for owners only, on the server.
// Nothing here writes to an order, an item or a quote: a final price goes through the quote workflow.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { ApiErrorCode, EstimateView, InquiryEstimatesResponse } from '../../shared/api'
import { ANALYZER_VERSION } from '../../shared/artworkAnalysis'
import { business } from '../../shared/business'
import { artworkReportSchema, PRINT_SIZES } from '../../shared/inquiry'
import type { AppEnv } from '../auth'
import * as db from '../db/inquiries'
import * as pricing from '../db/pricing'
import { parsePayload } from '../domain/inquiryConversion'
import { customerView, estimateRequestSchema, manual, parseConfig, type EstimateResult } from '../domain/pricing/engine'
import { reviewSeed, reviewedEstimate } from '../domain/pricing/facts'

const id = z.string().regex(/^[1-9]\d{0,14}$/).transform(Number)
const fail = (c: Context, status: 400 | 404 | 409, code: ApiErrorCode, error: string) => c.json({ error, code }, status)
const notFound = (c: Context) => fail(c, 404, 'not_found', 'Inquiry not found')
const decoration = z.object({
  location: z.string().trim().max(60).nullable(), size: z.enum(PRINT_SIZES).nullable(), colors: z.number().int().min(1).max(100).nullable(), complexity: z.enum(PRINT_SIZES).nullable(),
  machineMinutes: z.number().positive().max(1440).nullable(), fileId: z.number().int().positive().nullable(),
}).strict()
const reviewBody = z.object({
  basedOn: z.number().int().positive().nullable(),
  verified: z.literal(true), // the person looked at the stored original; the page won't send this until they say so
  reason: z.string().trim().max(1000).nullable(),
  reanalysis: z.array(z.object({ fileId: z.number().int().positive(), report: artworkReportSchema.nullable(), refused: z.enum(['unreadable', 'too_large', 'timed_out', 'unsupported']).nullable() }).strict()).max(20),
  lines: z.array(z.object({ method: z.enum(['screen', 'embroidery', 'dtg', 'laser_engrave', 'laser_cut', 'other', 'help']), decorations: z.array(decoration).max(10) }).strict()).min(1).max(10),
}).strict()

type StoredInternal = Pick<EstimateResult, 'totalCents' | 'assumptions' | 'lines' | 'reasons' | 'internal'>
type StoredInputs = { reanalysis?: { fileId: number; report: z.infer<typeof artworkReportSchema> | null; refused: string | null }[] }
const parse = <T>(raw: string): T | null => { try { return JSON.parse(raw) as T } catch { return null } }
// Staff see that an owner has to look, not that a margin rule fired. Whether a job clears the margin is the owner's to know.
const staffReason = (r: string) => (/margin/i.test(r) ? 'needs an owner to review the price' : r)

export function estimateRoutes() {
  return new Hono<AppEnv>()
    .get('/inquiries/:id/estimates', async (c) => {
      const i = id.safeParse(c.req.param('id'))
      if (!i.success) return notFound(c)
      const row = await db.getInquiry(c.env.DB, i.data)
      if (!row || row.deleting_at) return notFound(c)
      const [rows, overrides, files] = await Promise.all([pricing.listEstimates(c.env.DB, row.id), pricing.listOverrides(c.env.DB, row.id), db.listInquiryFiles(c.env.DB, row.id)])
      const owner = c.get('user').role === 'owner'
      const names = await pricing.userNames(c.env.DB, [...new Set(rows.flatMap((e) => (e.created_by === null ? [] : [e.created_by])))])
      const estimates = rows.map((e): EstimateView => {
        const r = parse<StoredInternal>(e.internal_result)
        const inputs = parse<StoredInputs>(e.inputs)
        return {
          id: e.id, status: e.status as EstimateView['status'], factsSource: e.facts_source as EstimateView['factsSource'], pricingVersionId: e.pricing_version_id, createdAt: e.created_at,
          createdBy: e.created_by === null ? null : names.get(e.created_by) ?? null,
          totalCents: r?.totalCents ?? null, assumptions: r?.assumptions ?? [], reasons: (r?.reasons ?? []).map(owner ? (x) => x : staffReason),
          lines: (r?.lines ?? []).map((l) => ({ label: l.label, quantity: l.quantity, unitPriceCents: l.unitPriceCents, lineTotalCents: l.lineTotalCents })),
          shownToCustomer: e.created_by === null ? { totalCents: parse<{ totalCents: number | null }>(e.customer_result)?.totalCents ?? null } : null,
          reanalysis: (inputs?.reanalysis ?? []).map((a) => ({ fileId: a.fileId, filename: files.find((f) => f.file_id === a.fileId)?.filename ?? null, refused: a.refused, estimatedInkColors: a.report?.estimatedInkColors ?? null, confidence: a.report?.confidence ?? null, flags: a.report?.flags ?? [] })),
          overrides: overrides.filter((o) => o.estimate_id === e.id).map((o) => ({ field: o.field, original: o.original, replacement: o.replacement, reason: o.reason, by: o.actor_name, at: o.created_at })),
          ...(owner && r ? { internal: { costCents: r.internal.costCents, marginBps: r.internal.marginBps } } : {}),
        }
      })
      const lines = parsePayload(row.payload)?.lines ?? []
      const latest = rows.at(-1)
      const body: InquiryEstimatesResponse = {
        estimates,
        seed: reviewSeed(lines, latest ? parse(latest.inputs) : null, new Map(files.map((f) => [f.upload_id, f.file_id])), productName),
        artworkFiles: files.filter((f) => f.kind === 'artwork').map((f) => ({ id: f.file_id, filename: f.filename, mime: f.mime })),
      }
      return c.json(body)
    })

    // Staff re-analysed the stored files and stand behind these facts. A new row: the customer's own estimate stays exactly as it was.
    .post('/inquiries/:id/estimates/review', async (c) => {
      const i = id.safeParse(c.req.param('id'))
      if (!i.success) return notFound(c)
      const b = reviewBody.safeParse(await c.req.json().catch(() => null))
      if (!b.success) return fail(c, 400, 'invalid_request', 'Invalid request')
      const row = await db.getInquiry(c.env.DB, i.data)
      if (!row || row.deleting_at) return notFound(c)
      const lines = parsePayload(row.payload)?.lines ?? []
      if (lines.length === 0 || b.data.lines.length !== lines.length) return fail(c, 400, 'invalid_request', 'Invalid request')

      const files = await db.listInquiryFiles(c.env.DB, row.id)
      const artwork = new Set(files.filter((f) => f.kind === 'artwork').map((f) => f.file_id))
      const analyses = new Map(b.data.reanalysis.map((a) => [a.fileId, a.report]))
      // Every stored artwork file is looked at, and nothing outside this inquiry can be named.
      const covered = [...artwork].every((f) => analyses.has(f)) && [...analyses.keys()].every((f) => artwork.has(f))
      const linked = b.data.lines.every((l) => l.decorations.every((d) => d.fileId === null || artwork.has(d.fileId)))
      if (!covered || !linked || b.data.reanalysis.some((a) => (a.report === null) === (a.refused === null))) return fail(c, 400, 'estimate_review_incomplete', 'Every stored artwork file must be re-analyzed first')

      const rows = await pricing.listEstimates(c.env.DB, row.id)
      const latest = rows.at(-1) ?? null
      if ((latest?.id ?? null) !== b.data.basedOn) return fail(c, 409, 'estimate_stale', 'This estimate changed, reload and retry')
      const seed = reviewSeed(lines, latest ? parse(latest.inputs) : null, new Map(files.map((f) => [f.upload_id, f.file_id])), productName)
      const active = await pricing.getActivePricing(c.env.DB)
      const worked = reviewedEstimate(parseConfig(active?.config), lines, seed, b.data.lines, analyses)
      if (worked.overrides.length > 0 && !b.data.reason) return fail(c, 400, 'estimate_reason_required', 'Say why these details changed')
      const result = estimateRequestSchema.safeParse(worked.request).success ? worked.result : manual(['the request is outside what can be calculated'])

      const reviewKey = crypto.randomUUID()
      const saved = await pricing.saveReview(c.env.DB, {
        inquiryId: row.id, pricingVersionId: active?.id ?? null, analyzerVersion: ANALYZER_VERSION, factsSource: 'staff_reviewed',
        inputs: { reviewKey, request: worked.request, links: worked.links, reanalysis: b.data.reanalysis },
        customerResult: customerView(result), result, createdBy: c.get('user').id, basedOn: b.data.basedOn, reviewKey, reason: b.data.reason, overrides: worked.overrides, actorId: c.get('user').id,
      })
      return saved ? c.json({ ok: true }, 201) : fail(c, 409, 'estimate_stale', 'This estimate changed, reload and retry')
    })
}

const productName = (slug: string) => business.storefront.products.find((p) => p.slug === slug)?.name ?? slug
