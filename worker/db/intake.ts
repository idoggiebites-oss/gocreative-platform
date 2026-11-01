// SQL for public inquiries. Every limit is enforced inside a single conditional statement, so parallel requests can't overrun it.
import type { InquirySubmit } from '../../shared/inquiry'
import * as limits from '../domain/intake'
import type { NewFile } from './files'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
const OPEN = `status = 'open' AND expires_at > ${NOW}`
// A reservation is live for the upload deadline. Past it, it counts for nothing, can't settle and blocks nobody; cron collects it.
const LIVE = `status = 'reserved' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-${limits.UPLOAD_DEADLINE_MINUTES} minutes')`
// Held against the storage cap until a deletion is confirmed; a linked file counts until conversion moves it on (S3).
const OUTSTANDING = `COALESCE((SELECT SUM(bytes) FROM inquiry_files WHERE status IN ('stored','linked','deleting') OR (${LIVE})), 0)`
const IN_FLIGHT = `COALESCE((SELECT SUM(bytes) FROM inquiry_files WHERE ${LIVE}), 0)`
const usage = (column: 'sessions' | 'bytes') => `COALESCE((SELECT ${column} FROM intake_usage WHERE day = ?), 0)`

export type SessionRow = { id: string; status: 'open' | 'submitted' | 'expiring'; expired: number }
export async function findSession(db: D1Database, tokenHash: string) {
  return db.prepare(`SELECT id, status, expires_at <= ${NOW} AS expired FROM inquiry_submissions WHERE token_hash = ?`).bind(tokenHash).first<SessionRow>()
}

/** False when any admission limit refused it. Which one stays unsaid to the caller. */
export async function openSession(db: D1Database, p: { id: string; tokenHash: string; ipHash: string; expiresAt: string; day: string }) {
  const [inserted] = await db.batch([
    db.prepare(`INSERT INTO inquiry_submissions (id, token_hash, ip_hash, expires_at) SELECT ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM inquiry_submissions WHERE ip_hash = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')) < ?
        AND (SELECT COUNT(*) FROM inquiry_submissions WHERE ${OPEN}) < ?
        AND ${usage('sessions')} < ?`)
      .bind(p.id, p.tokenHash, p.ipHash, p.expiresAt, p.ipHash, limits.IP_SESSIONS_PER_HOUR, limits.OPEN_SESSIONS_MAX, p.day, limits.DAILY_MAX_SESSIONS),
    db.prepare(`INSERT INTO intake_usage (day, sessions) SELECT ?, 1 WHERE EXISTS (SELECT 1 FROM inquiry_submissions WHERE id = ?)
      ON CONFLICT (day) DO UPDATE SET sessions = sessions + 1`).bind(p.day, p.id),
  ])
  return inserted.meta.changes > 0
}

/** Holds the declared bytes before any are read. False when a cap refused it. */
export async function reserveFile(db: D1Database, p: { id: string; submissionId: string; r2Key: string; kind: 'artwork' | 'po'; bytes: number; day: string }) {
  const held = `FROM inquiry_files WHERE submission_id = ? AND (status = 'stored' OR (${LIVE}))`
  const inserted = await db.prepare(`INSERT INTO inquiry_files (id, submission_id, r2_key, kind, bytes) SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM inquiry_submissions WHERE id = ? AND ${OPEN})
        AND (SELECT COUNT(*) FROM inquiry_files WHERE submission_id = ?) < ?
        AND (SELECT COUNT(*) ${held}) < ?
        AND (SELECT COALESCE(SUM(bytes), 0) ${held}) + ? <= ?
        AND ${OUTSTANDING} + ? <= ?
        AND ${usage('bytes')} + ${IN_FLIGHT} + ? <= ?`)
      .bind(p.id, p.submissionId, p.r2Key, p.kind, p.bytes, p.submissionId, p.submissionId, limits.SESSION_MAX_ATTEMPTS, p.submissionId, limits.SESSION_MAX_FILES, p.submissionId, p.bytes, limits.SESSION_MAX_BYTES,
        p.bytes, limits.OUTSTANDING_MAX_BYTES, p.day, p.bytes, limits.DAILY_MAX_BYTES).run()
  return inserted.meta.changes > 0
}

/**
 * reserved -> stored, only while the session is still open. Null means it lost: the caller's object must go. The daily
 * budget is charged here, for bytes actually stored: a declared size only holds headroom while in flight, or one session
 * could spend it all on uploads refused after the first few bytes (Codex).
 */
export async function settleFile(db: D1Database, id: string, file: NewFile, day: string) {
  const [r] = await db.batch([
    db.prepare(`UPDATE inquiry_files SET status = 'stored', mime = ?, sha256 = ?, filename = ?
      WHERE id = ? AND ${LIVE} AND EXISTS (SELECT 1 FROM inquiry_submissions s WHERE s.id = submission_id AND s.status = 'open')`)
      .bind(file.mime, file.sha256, file.filename, id),
    db.prepare(`INSERT INTO intake_usage (day, bytes) SELECT ?, ? WHERE changes() > 0
      ON CONFLICT (day) DO UPDATE SET bytes = bytes + excluded.bytes`).bind(day, file.bytes),
  ])
  return r.meta.changes > 0 ? { id, filename: file.filename, bytes: file.bytes } : null
}

/** The object is certainly gone (or never existed): the reservation comes back. */
export const markFailed = (db: D1Database, id: string, from: string[] = ['reserved', 'stored']) =>
  db.prepare(`UPDATE inquiry_files SET status = 'failed' WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`).bind(id, ...from).run()
/** An object may exist: cron retries the delete, and the bytes stay held until it succeeds. */
export const markDeleting = (db: D1Database, id: string, from: string[] = ['reserved', 'stored']) =>
  db.prepare(`UPDATE inquiry_files SET status = 'deleting' WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`).bind(id, ...from).run()
/** Claims a stored file before its object is touched, so a concurrent submit can no longer link it. */
export const claimStored = async (db: D1Database, id: string, submissionId: string) =>
  (await db.prepare(`UPDATE inquiry_files SET status = 'deleting' WHERE id = ? AND submission_id = ? AND status = 'stored'
    AND EXISTS (SELECT 1 FROM inquiry_submissions s WHERE s.id = ? AND s.status = 'open') RETURNING r2_key`).bind(id, submissionId, submissionId).first<{ r2_key: string }>())?.r2_key ?? null

/** A session's own stored uploads, so a browser that lost an acknowledgement or reloaded can see what would be sent. Only what the customer sent. */
export const listStoredFiles = async (db: D1Database, submissionId: string) =>
  (await db.prepare(`SELECT id, filename, bytes, kind AS purpose FROM inquiry_files WHERE submission_id = ? AND status = 'stored' ORDER BY created_at`).bind(submissionId)
    .all<{ id: string; filename: string | null; bytes: number; purpose: 'artwork' | 'po' }>()).results

/** Where the orphan sweep got to, so a long bucket can't hide objects past its first pages. */
export const orphanCursor = async (db: D1Database) =>
  (await db.prepare(`SELECT value FROM settings WHERE key = 'orphan_cursor'`).first<{ value: string }>())?.value
export const saveOrphanCursor = (db: D1Database, cursor: string | undefined) => cursor
  ? db.prepare(`INSERT INTO settings (key, value) VALUES ('orphan_cursor', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(cursor).run()
  : db.prepare(`DELETE FROM settings WHERE key = 'orphan_cursor'`).run()

export const sessionFileKinds = async (db: D1Database, submissionId: string) =>
  (await db.prepare(`SELECT kind, status, ${LIVE} AS live FROM inquiry_files WHERE submission_id = ?`).bind(submissionId).all<{ kind: string; status: string; live: number }>()).results

export const findRef = async (db: D1Database, submissionId: string) =>
  (await db.prepare(`SELECT ref FROM inquiries WHERE submission_id = ?`).bind(submissionId).first<{ ref: string }>())?.ref ?? null

/**
 * One batch: the inquiry, its files linked, the audit row, and the session closed last. Everything is guarded on the
 * session being open with no upload in flight, so false means nothing happened and the caller works out why.
 */
export async function submitInquiry(db: D1Database, p: { submissionId: string; ref: string; ipHash: string; input: Omit<InquirySubmit, 'website'>; spam: boolean }) {
  const i = p.input
  const payload = JSON.stringify({ lines: i.lines, designHelp: i.designHelp ?? false, description: i.description ?? null })
  const sid = p.submissionId
  const mine = `(SELECT id FROM inquiries WHERE submission_id = ?)`
  // True only for the batch that just inserted: a losing retry also finds the inquiry, but the winner closed the session.
  const justInserted = `EXISTS (SELECT 1 FROM inquiries WHERE submission_id = ?) AND EXISTS (SELECT 1 FROM inquiry_submissions WHERE id = ? AND status = 'open')`
  const [inserted] = await db.batch([
    db.prepare(`INSERT INTO inquiries (payload, contact_name, contact_email, contact_phone, status, ref, submission_id, customer_kind, organization, preferred_contact, due_date, ip_hash)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM inquiry_submissions WHERE id = ? AND ${OPEN})
        AND NOT EXISTS (SELECT 1 FROM inquiry_files WHERE submission_id = ? AND ${LIVE})
        AND (? <> 'individual' OR NOT EXISTS (SELECT 1 FROM inquiry_files WHERE submission_id = ? AND status = 'stored' AND kind = 'po'))`)
      .bind(payload, i.contactName, i.contactEmail ?? null, i.contactPhone ?? null, p.spam ? 'spam' : 'new', p.ref, sid, i.customerKind, i.organization ?? null, i.preferredContact ?? null, i.dueDate ?? null, p.ipHash, sid, sid, i.customerKind, sid),
    db.prepare(`INSERT INTO files (r2_key, mime, bytes, sha256, via_portal, filename)
      SELECT r2_key, mime, bytes, sha256, 1, filename FROM inquiry_files WHERE submission_id = ? AND status = 'stored' AND ${justInserted}`).bind(sid, sid, sid),
    db.prepare(`UPDATE inquiry_files SET status = 'linked', inquiry_id = ${mine}, file_id = (SELECT id FROM files WHERE files.r2_key = inquiry_files.r2_key)
      WHERE submission_id = ? AND status = 'stored' AND ${justInserted}`).bind(sid, sid, sid, sid),
    // Counts only: the audit trail outlives retention, so no submitted personal data.
    db.prepare(`INSERT INTO activity_log (actor_kind, entity_type, entity_id, action, after)
      SELECT 'portal', 'inquiry', id, 'inquiry_received', json_object('files', (SELECT COUNT(*) FROM inquiry_files WHERE submission_id = ? AND status = 'linked')) FROM inquiries WHERE submission_id = ? AND EXISTS (SELECT 1 FROM inquiry_submissions WHERE id = ? AND status = 'open')`).bind(sid, sid, sid),
    db.prepare(`UPDATE inquiry_submissions SET status = 'submitted' WHERE id = ? AND status = 'open' AND EXISTS (SELECT 1 FROM inquiries WHERE submission_id = ?)`).bind(sid, sid),
  ])
  return inserted.meta.changes > 0
}

// ---- cleanup (worker/cron.ts) ----

/** Claims expired sessions in one step, so submit and settle can't win afterwards, and queues their files. */
export async function claimExpired(db: D1Database) {
  await db.batch([
    db.prepare(`UPDATE inquiry_submissions SET status = 'expiring' WHERE status = 'open' AND expires_at <= ${NOW}`),
    db.prepare(`UPDATE inquiry_files SET status = 'deleting' WHERE status IN ('reserved','stored')
      AND submission_id IN (SELECT id FROM inquiry_submissions WHERE status = 'expiring')`),
    db.prepare(`UPDATE inquiry_files SET status = 'deleting' WHERE status = 'reserved' AND NOT (${LIVE})`),
  ])
}

export const filesToDelete = async (db: D1Database, limit: number) =>
  (await db.prepare(`SELECT id, r2_key FROM inquiry_files WHERE status = 'deleting' LIMIT ?`).bind(limit).all<{ id: string; r2_key: string }>()).results

export const forgetFiles = (db: D1Database, ids: string[]) =>
  db.batch(ids.map((id) => db.prepare(`DELETE FROM inquiry_files WHERE id = ? AND status = 'deleting'`).bind(id)))

/** Failed rows hold nothing, and an expiring session with no files left is finished. */
export async function sweepFinished(db: D1Database) {
  await db.batch([
    db.prepare(`DELETE FROM inquiry_files WHERE status = 'failed' AND submission_id IN (SELECT id FROM inquiry_submissions WHERE status <> 'open')`),
    db.prepare(`DELETE FROM inquiry_submissions WHERE status = 'expiring' AND NOT EXISTS (SELECT 1 FROM inquiry_files f WHERE f.submission_id = inquiry_submissions.id)`),
    db.prepare(`DELETE FROM intake_usage WHERE day < date('now', ?)`).bind(`-${limits.USAGE_KEEP_DAYS} days`),
  ])
}

/** Every key a row still names, for orphan reconciliation. Bounded by the storage cap. */
export const knownKeys = async (db: D1Database) =>
  new Set((await db.prepare(`SELECT r2_key FROM inquiry_files UNION SELECT r2_key FROM files WHERE r2_key LIKE 'inquiries/%'`).all<{ r2_key: string }>()).results.map((r) => r.r2_key))
