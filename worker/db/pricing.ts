// SQL for pricing versions and estimates. Costs and margins live here and in internal_result: no public route reads these columns.
import type { EstimateResult, PricingConfig } from '../domain/pricing/engine'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`

export type PricingVersionRow = { id: number; status: 'draft' | 'active' | 'retired'; config: string; config_hash: string; rollback_of: number | null; note: string | null; created_by: number; created_at: string; published_by: number | null; published_at: string | null }
const COLS = 'id, status, config, config_hash, rollback_of, note, created_by, created_at, published_by, published_at'

export const getActivePricing = (db: D1Database) => db.prepare(`SELECT ${COLS} FROM pricing_versions WHERE status = 'active'`).first<PricingVersionRow>()
export const getDraftPricing = (db: D1Database) => db.prepare(`SELECT ${COLS} FROM pricing_versions WHERE status = 'draft'`).first<PricingVersionRow>()
export const getPricingVersion = (db: D1Database, id: number) => db.prepare(`SELECT ${COLS} FROM pricing_versions WHERE id = ?`).bind(id).first<PricingVersionRow>()
export type PricingVersionSummary = { id: number; status: string; note: string | null; rollback_of: number | null; created_at: string; published_at: string | null; published_by_name: string | null; config_hash: string }
export const listPricingVersions = async (db: D1Database) =>
  (await db.prepare(`SELECT v.id, v.status, v.note, v.rollback_of, v.created_at, v.published_at, u.name AS published_by_name, v.config_hash FROM pricing_versions v
    LEFT JOIN users u ON u.id = v.published_by ORDER BY v.id DESC LIMIT 100`).all<PricingVersionSummary>()).results

export const discardDraft = async (db: D1Database, hash: string) =>
  ((await db.prepare(`DELETE FROM pricing_versions WHERE status = 'draft' AND config_hash = ?`).bind(hash).run()).meta.changes ?? 0) > 0

const canonical = (v: unknown): unknown => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)])) : v)
/** The same config always hashes the same, whatever order its keys were entered in, so a preview can be bound to exactly what it showed. */
export async function hashConfig(config: PricingConfig) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(config))))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Creates the draft, or replaces it if the caller saw its current hash (expectedHash: null means "there was none"). There is one draft at a time.
 * False means someone else changed it: nothing was written.
 */
export async function saveDraft(db: D1Database, p: { config: PricingConfig; expectedHash: string | null; actorId: number; note: string | null; rollbackOf?: number | null }) {
  const json = JSON.stringify(p.config)
  const hash = await hashConfig(p.config)
  const write = p.expectedHash === null
    ? db.prepare(`INSERT INTO pricing_versions (config, config_hash, note, created_by, rollback_of) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM pricing_versions WHERE status = 'draft')`)
      .bind(json, hash, p.note, p.actorId, p.rollbackOf ?? null)
    : db.prepare(`UPDATE pricing_versions SET config = ?, config_hash = ?, note = ?, created_by = ?, rollback_of = ? WHERE status = 'draft' AND config_hash = ?`)
      .bind(json, hash, p.note, p.actorId, p.rollbackOf ?? null, p.expectedHash)
  const [r] = await db.batch([
    write,
    // The audit trail records that it changed and who did it. The rates themselves stay in the owner-only version history.
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action) SELECT 'user', ?, 'pricing_version', id, 'pricing_draft_saved' FROM pricing_versions WHERE status = 'draft' AND changes() > 0`).bind(p.actorId),
  ])
  return (r.meta.changes ?? 0) > 0 ? hash : null
}

/**
 * One atomic step, bound to what the publisher previewed: both the active version they compared against and the draft's exact content.
 * A concurrent publish, or a draft edited after the preview, changes nothing and returns false.
 */
export async function publishDraft(db: D1Database, p: { draftId: number; draftHash: string; expectedActiveId: number | null; actorId: number }) {
  const draftOk = `EXISTS (SELECT 1 FROM pricing_versions d WHERE d.id = ? AND d.status = 'draft' AND d.config_hash = ?)`
  const results = await db.batch([
    db.prepare(`UPDATE pricing_versions SET status = 'retired' WHERE status = 'active' AND id IS ? AND ${draftOk}`).bind(p.expectedActiveId, p.draftId, p.draftHash),
    db.prepare(`UPDATE pricing_versions SET status = 'active', published_by = ?, published_at = ${NOW}
      WHERE id = ? AND status = 'draft' AND config_hash = ? AND NOT EXISTS (SELECT 1 FROM pricing_versions a WHERE a.status = 'active')
        AND (? IS NULL OR EXISTS (SELECT 1 FROM pricing_versions e WHERE e.id = ? AND e.status = 'retired'))`).bind(p.actorId, p.draftId, p.draftHash, p.expectedActiveId, p.expectedActiveId),
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
      SELECT 'user', ?, 'pricing_version', ?, 'pricing_published', json_object('replaced', ?, 'rollback_of', rollback_of) FROM pricing_versions WHERE id = ? AND status = 'active' AND changes() > 0`)
      .bind(p.actorId, p.draftId, p.expectedActiveId, p.draftId),
  ])
  return (results[1]?.meta.changes ?? 0) > 0
}

export type NewEstimate = {
  inquiryId: number; pricingVersionId: number | null; analyzerVersion: number | null; factsSource: 'none' | 'customer_reported' | 'staff_reviewed'
  inputs: unknown; customerResult: unknown; result: EstimateResult; createdBy: number | null
}
const ESTIMATE_COLS = 'inquiry_id, pricing_version_id, engine_version, analyzer_version, status, facts_source, inputs, customer_result, internal_result, created_by'
/** The binds after the inquiry id. The figure stays here too: what the customer was shown can be less than what was calculated, while customer prices are off. */
export const estimateBinds = (e: Omit<NewEstimate, 'inquiryId'>) => [e.pricingVersionId, e.result.engineVersion, e.analyzerVersion, e.result.status, e.factsSource, JSON.stringify(e.inputs), JSON.stringify(e.customerResult),
  JSON.stringify({ totalCents: e.result.totalCents, assumptions: e.result.assumptions, lines: e.result.lines, reasons: e.result.reasons, internal: e.result.internal }), e.createdBy]
/** For the submit batch: the row of the inquiry that batch just inserted, or nothing if it didn't. */
export const estimateForSubmission = (db: D1Database, submissionId: string, e: Omit<NewEstimate, 'inquiryId'>) =>
  db.prepare(`INSERT INTO inquiry_estimates (${ESTIMATE_COLS}) SELECT i.id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM inquiries i WHERE i.submission_id = ? AND EXISTS (SELECT 1 FROM inquiry_submissions s WHERE s.id = ? AND s.status = 'open')`)
    .bind(...estimateBinds(e), submissionId, submissionId)
/** A new row every time. Existing ones never change, so an estimate always shows what it said when it was made. */
export async function saveEstimate(db: D1Database, e: NewEstimate) {
  const r = await db.prepare(`INSERT INTO inquiry_estimates (${ESTIMATE_COLS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM inquiries WHERE id = ? AND deleting_at IS NULL)`)
    .bind(e.inquiryId, ...estimateBinds(e), e.inquiryId).run()
  return (r.meta.changes ?? 0) > 0 ? r.meta.last_row_id : null
}

/**
 * A staff review, in one batch: the new estimate, each correction beside it, and a counts-only audit row. Guarded on the estimate the reviewer was looking at
 * still being the latest, so a stale screen or a double-tap writes nothing. It touches no order, item or quote.
 */
export async function saveReview(db: D1Database, e: NewEstimate & { basedOn: number | null; reviewKey: string; reason: string | null; overrides: { field: string; original: string | null; replacement: string | null }[]; actorId: number }) {
  const mine = `FROM inquiry_estimates e WHERE e.inquiry_id = ? AND json_extract(e.inputs, '$.reviewKey') = ?`
  const [inserted] = await db.batch([
    db.prepare(`INSERT INTO inquiry_estimates (${ESTIMATE_COLS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM inquiries WHERE id = ? AND deleting_at IS NULL) AND COALESCE((SELECT MAX(id) FROM inquiry_estimates WHERE inquiry_id = ?), 0) = ?`)
      .bind(e.inquiryId, ...estimateBinds(e), e.inquiryId, e.inquiryId, e.basedOn ?? 0),
    ...e.overrides.map((o) => db.prepare(`INSERT INTO estimate_overrides (estimate_id, field, original, replacement, reason, actor_id) SELECT e.id, ?, ?, ?, ?, ? ${mine}`)
      .bind(o.field, o.original, o.replacement, e.reason, e.actorId, e.inquiryId, e.reviewKey)),
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after) SELECT 'user', ?, 'inquiry', ?, 'estimate_reviewed', json_object('estimate', e.id, 'overrides', ?) ${mine}`)
      .bind(e.actorId, e.inquiryId, e.overrides.length, e.inquiryId, e.reviewKey),
  ])
  return (inserted.meta.changes ?? 0) > 0
}

export type EstimateRow = { id: number; inquiry_id: number; pricing_version_id: number | null; engine_version: number; analyzer_version: number | null; status: string; facts_source: string; inputs: string; customer_result: string; internal_result: string; created_by: number | null; created_at: string }
export const listEstimates = async (db: D1Database, inquiryId: number) =>
  (await db.prepare(`SELECT * FROM inquiry_estimates WHERE inquiry_id = ? ORDER BY id`).bind(inquiryId).all<EstimateRow>()).results

export const addEstimateOverride = async (db: D1Database, o: { estimateId: number; field: string; original: string | null; replacement: string | null; reason: string; actorId: number }) =>
  (await db.prepare(`INSERT INTO estimate_overrides (estimate_id, field, original, replacement, reason, actor_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(o.estimateId, o.field, o.original, o.replacement, o.reason, o.actorId).run()).meta.last_row_id

export type OverrideRow = { id: number; estimate_id: number; field: string; original: string | null; replacement: string | null; reason: string; actor_id: number; actor_name: string | null; created_at: string }
export const listOverrides = async (db: D1Database, inquiryId: number) =>
  (await db.prepare(`SELECT o.id, o.estimate_id, o.field, o.original, o.replacement, o.reason, o.actor_id, u.name AS actor_name, o.created_at FROM estimate_overrides o
    JOIN inquiry_estimates e ON e.id = o.estimate_id LEFT JOIN users u ON u.id = o.actor_id WHERE e.inquiry_id = ? ORDER BY o.id`).bind(inquiryId).all<OverrideRow>()).results
export const userNames = async (db: D1Database, ids: number[]) =>
  ids.length === 0 ? new Map<number, string>() : new Map((await db.prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ id: number; name: string }>()).results.map((u) => [u.id, u.name]))

/** What the customer's own submission said, for a retry that lost its reply. Nothing else leaves this table for the public. */
export const customerResultOf = async (db: D1Database, submissionId: string) =>
  (await db.prepare(`SELECT e.customer_result FROM inquiry_estimates e JOIN inquiries i ON i.id = e.inquiry_id WHERE i.submission_id = ? AND e.created_by IS NULL ORDER BY e.id LIMIT 1`).bind(submissionId).first<{ customer_result: string }>())?.customer_result ?? null
