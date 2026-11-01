// SQL for pricing versions and estimates. Costs and margins live here and in internal_result: no public route reads these columns.
import type { EstimateResult, PricingConfig } from '../domain/pricing/engine'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`

export type PricingVersionRow = { id: number; status: 'draft' | 'active' | 'retired'; config: string; config_hash: string; rollback_of: number | null; note: string | null; created_by: number; created_at: string; published_by: number | null; published_at: string | null }
const COLS = 'id, status, config, config_hash, rollback_of, note, created_by, created_at, published_by, published_at'

export const getActivePricing = (db: D1Database) => db.prepare(`SELECT ${COLS} FROM pricing_versions WHERE status = 'active'`).first<PricingVersionRow>()
export const getDraftPricing = (db: D1Database) => db.prepare(`SELECT ${COLS} FROM pricing_versions WHERE status = 'draft'`).first<PricingVersionRow>()
export const getPricingVersion = (db: D1Database, id: number) => db.prepare(`SELECT ${COLS} FROM pricing_versions WHERE id = ?`).bind(id).first<PricingVersionRow>()
export const listPricingVersions = async (db: D1Database) =>
  (await db.prepare(`SELECT ${COLS} FROM pricing_versions ORDER BY id DESC LIMIT 100`).all<PricingVersionRow>()).results

/** The same config always hashes the same, so a preview can be bound to exactly what it showed. */
export async function hashConfig(config: PricingConfig) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(config)))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Creates the draft, or replaces it if the caller saw its current hash (expectedHash: null means "there was none"). There is one draft at a time.
 * False means someone else changed it: nothing was written.
 */
export async function saveDraft(db: D1Database, p: { config: PricingConfig; expectedHash: string | null; actorId: number; note: string | null; rollbackOf?: number | null }) {
  const json = JSON.stringify(p.config)
  const hash = await hashConfig(p.config)
  const r = p.expectedHash === null
    ? await db.prepare(`INSERT INTO pricing_versions (config, config_hash, note, created_by, rollback_of) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM pricing_versions WHERE status = 'draft')`)
      .bind(json, hash, p.note, p.actorId, p.rollbackOf ?? null).run()
    : await db.prepare(`UPDATE pricing_versions SET config = ?, config_hash = ?, note = ?, created_by = ?, rollback_of = ? WHERE status = 'draft' AND config_hash = ?`)
      .bind(json, hash, p.note, p.actorId, p.rollbackOf ?? null, p.expectedHash).run()
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
/** A new row every time. Existing ones never change, so an estimate always shows what it said when it was made. */
export async function saveEstimate(db: D1Database, e: NewEstimate) {
  const r = await db.prepare(`INSERT INTO inquiry_estimates (inquiry_id, pricing_version_id, engine_version, analyzer_version, status, facts_source, inputs, customer_result, internal_result, created_by)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM inquiries WHERE id = ? AND deleting_at IS NULL)`)
    .bind(e.inquiryId, e.pricingVersionId, e.result.engineVersion, e.analyzerVersion, e.result.status, e.factsSource, JSON.stringify(e.inputs), JSON.stringify(e.customerResult),
      JSON.stringify({ lines: e.result.lines, reasons: e.result.reasons, internal: e.result.internal }), e.createdBy, e.inquiryId).run()
  return (r.meta.changes ?? 0) > 0 ? r.meta.last_row_id : null
}

export type EstimateRow = { id: number; inquiry_id: number; pricing_version_id: number | null; engine_version: number; analyzer_version: number | null; status: string; facts_source: string; inputs: string; customer_result: string; internal_result: string; created_by: number | null; created_at: string }
export const listEstimates = async (db: D1Database, inquiryId: number) =>
  (await db.prepare(`SELECT * FROM inquiry_estimates WHERE inquiry_id = ? ORDER BY id`).bind(inquiryId).all<EstimateRow>()).results

export const addEstimateOverride = async (db: D1Database, o: { estimateId: number; field: string; original: string | null; replacement: string | null; reason: string; actorId: number }) =>
  (await db.prepare(`INSERT INTO estimate_overrides (estimate_id, field, original, replacement, reason, actor_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(o.estimateId, o.field, o.original, o.replacement, o.reason, o.actorId).run()).meta.last_row_id
