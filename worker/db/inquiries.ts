// SQL for the staff side of inquiries: review, conversion and deletion. Conversion is one batch: every statement is guarded on
// the inquiry still being new at the version staff saw, so a stale or repeated request changes nothing at all.
import type { ProductionStatus, PaymentTerms, CustomerKind, InquiryStatus } from '../../shared/enums'
import type { ConvertedItem } from '../domain/inquiryConversion'
import { COUNTER_SQL, ITEM_COLS, NEW_NUMBER, counterN, itemBinds } from './orders'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`

export type InquiryRow = {
  id: number; payload: string; contact_name: string | null; contact_email: string | null; contact_phone: string | null; status: InquiryStatus
  order_id: number | null; created_at: string; ref: string | null; customer_kind: CustomerKind | null; organization: string | null
  preferred_contact: string | null; due_date: string | null; decline_reason: string | null; converted_at: string | null; version: number; deleting_at: string | null
}
const COLS = `id, payload, contact_name, contact_email, contact_phone, status, order_id, created_at, ref, customer_kind, organization, preferred_contact, due_date, decline_reason, converted_at, version, deleting_at`
export const getInquiry = (db: D1Database, id: number) => db.prepare(`SELECT ${COLS} FROM inquiries WHERE id = ?`).bind(id).first<InquiryRow>()

export type InquiryFileRow = { file_id: number; kind: 'artwork' | 'po'; filename: string | null; mime: string; bytes: number }
export const listInquiryFiles = async (db: D1Database, inquiryId: number) =>
  (await db.prepare(`SELECT i.file_id, i.kind, f.filename, f.mime, f.bytes FROM inquiry_files i JOIN files f ON f.id = i.file_id
    WHERE i.inquiry_id = ? AND i.status = 'linked' ORDER BY f.id`).bind(inquiryId).all<InquiryFileRow>()).results

export const orderNumberOf = async (db: D1Database, orderId: number | null) =>
  orderId === null ? null : (await db.prepare('SELECT number FROM orders WHERE id = ?').bind(orderId).first<{ number: string }>())?.number ?? null

const digits = (s: string) => s.replace(/\D/g, '')
/** Customers a request may belong to, by the same email or phone on the customer or one of its live contacts. A suggestion for staff to confirm, never applied by itself. */
export async function matchCustomers(db: D1Database, email: string | null, phone: string | null) {
  const mail = email?.trim().toLowerCase() || null
  const tel = phone ? digits(phone) : ''
  if (!mail && tel.length < 7) return []
  const strip = (col: string) => `replace(replace(replace(replace(replace(replace(COALESCE(${col}, ''),' ',''),'-',''),'(',''),')',''),'.',''),'+','')`
  const { results } = await db.prepare(`SELECT DISTINCT c.id, c.name, c.kind FROM customers c LEFT JOIN customer_contacts k ON k.customer_id = c.id AND k.archived_at IS NULL
    WHERE (?1 IS NOT NULL AND (lower(c.email) = ?1 OR lower(k.email) = ?1)) OR (length(?2) >= 7 AND (${strip('c.phone')} LIKE '%' || ?2 OR ${strip('k.phone')} LIKE '%' || ?2))
    ORDER BY c.name LIMIT 10`).bind(mail, tel).all<{ id: number; name: string; kind: CustomerKind }>()
  return Promise.all(results.map(async (c) => ({
    ...c,
    contacts: (await db.prepare(`SELECT id, name, email, phone FROM customer_contacts WHERE customer_id = ? AND archived_at IS NULL ORDER BY is_primary DESC, name`).bind(c.id)
      .all<{ id: number; name: string; email: string | null; phone: string | null }>()).results,
  })))
}

export type ConvertInput = {
  inquiryId: number; version: number; actorId: number; year: number; title: string; dueDate: string | null
  customer: { existingId: number; contactId: number | null } | { new: { name: string; kind: CustomerKind; organization: string | null; defaultPoRequired: boolean; defaultPaymentTerms: PaymentTerms } }
  contact: { name: string; email: string | null; phone: string | null }
  poRequired: boolean; paymentTerms: PaymentTerms; artworkRequired: boolean; productionStatus: ProductionStatus
  items: ConvertedItem[]; description: string | null; files: InquiryFileRow[]
}

/** Null when nothing happened (not new any more, a stale version, or a customer or contact that moved). Otherwise the order number's sequence. */
export async function convertInquiry(db: D1Database, p: ConvertInput) {
  const ok = `EXISTS (SELECT 1 FROM inquiries gi WHERE gi.id = ? AND gi.version = ? AND gi.status = 'new' AND gi.deleting_at IS NULL)`
  const okB = [p.inquiryId, p.version]
  const chosen = `(SELECT converted_customer_id FROM inquiries WHERE id = ?)`
  const chosenContact = `(SELECT converted_contact_id FROM inquiries WHERE id = ?)`
  const setCustomer = (sql: string, ...b: (string | number | null)[]) => db.prepare(`UPDATE inquiries SET ${sql} WHERE id = ? AND ${ok}`).bind(...b, p.inquiryId, ...okB)
  const order = `(SELECT id FROM orders WHERE number = ${NEW_NUMBER})`

  const who = 'existingId' in p.customer
    ? [
        setCustomer('converted_customer_id = (SELECT id FROM customers WHERE id = ?)', p.customer.existingId),
        // A chosen contact must be this customer's and live; otherwise the guard below stops the whole conversion.
        ...(p.customer.contactId !== null
          ? [setCustomer('converted_contact_id = (SELECT id FROM customer_contacts WHERE id = ? AND customer_id = ? AND archived_at IS NULL)', p.customer.contactId, p.customer.existingId)]
          : []),
      ]
    : [
        db.prepare(`INSERT INTO customers (name, kind, organization, email, phone, default_po_required, default_payment_terms) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${ok}`)
          .bind(p.customer.new.name, p.customer.new.kind, p.customer.new.organization, p.contact.email, p.contact.phone, p.customer.new.defaultPoRequired ? 1 : 0, p.customer.new.defaultPaymentTerms, ...okB),
        setCustomer('converted_customer_id = last_insert_rowid()'),
        db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
          SELECT 'user', ?, 'customer', converted_customer_id, 'customer_created', json_object('from_inquiry', id) FROM inquiries WHERE id = ? AND ${ok}`).bind(p.actorId, p.inquiryId, ...okB),
      ]
  const needsContact = !('existingId' in p.customer) || p.customer.contactId === null
  const contact = needsContact
    ? [
        db.prepare(`INSERT INTO customer_contacts (customer_id, name, email, phone, is_primary)
          SELECT i.converted_customer_id, ?, ?, ?, ? FROM inquiries i WHERE i.id = ? AND i.converted_customer_id IS NOT NULL AND ${ok}`)
          .bind(p.contact.name, p.contact.email, p.contact.phone, 'existingId' in p.customer ? 0 : 1, p.inquiryId, ...okB),
        setCustomer('converted_contact_id = last_insert_rowid()'),
      ]
    : []
  // Past here a missing customer or contact stops everything, like a stale version.
  const full = `${ok} AND (SELECT converted_customer_id IS NOT NULL AND converted_contact_id IS NOT NULL FROM inquiries WHERE id = ?)`
  const fullB = [...okB, p.inquiryId]

  const results = await db.batch([
    ...who,
    ...contact,
    db.prepare(COUNTER_SQL(full)).bind(p.year, ...fullB),
    db.prepare(`INSERT INTO orders (number, customer_id, contact_id, source, title, due_date, po_required, payment_terms, artwork_required, production_status, created_by)
      SELECT ${NEW_NUMBER}, ${chosen}, ${chosenContact}, 'portal', ?, ?, ?, ?, ?, ?, ? WHERE ${full}`)
      .bind(p.year, p.inquiryId, p.inquiryId, p.title, p.dueDate, p.poRequired ? 1 : 0, p.paymentTerms, p.artworkRequired ? 1 : 0, p.productionStatus, p.actorId, ...fullB),
    ...p.items.map((i) => db.prepare(`INSERT INTO order_items (order_id, ${ITEM_COLS}, notes) SELECT ${order}, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${full}`)
      .bind(p.year, ...itemBinds(i), i.notes, ...fullB)),
    ...(p.description ? [db.prepare(`INSERT INTO notes (entity_type, entity_id, author_id, body) SELECT 'order', ${order}, ?, ? WHERE ${full}`).bind(p.year, p.actorId, `From the customer's request:\n${p.description}`, ...fullB)] : []),
    // Each artwork file is its own design at version 1, under review: a public upload never counts as approved.
    ...p.files.filter((f) => f.kind === 'artwork').map((f) => db.prepare(`INSERT INTO artwork (customer_id, order_id, lineage_id, version, file_id, design_name, approval_status)
      SELECT ${chosen}, ${order}, (SELECT COALESCE(MAX(lineage_id), 0) + 1 FROM artwork), 1, ?, ?, 'under_review' WHERE ${full}`)
      .bind(p.inquiryId, p.year, f.file_id, f.filename ? f.filename.slice(0, 200) : null, ...fullB)),
    // A customer's PO arrives as 'received': on file, and unverified until staff approve it through the normal PO workflow.
    ...p.files.filter((f) => f.kind === 'po').flatMap((f) => [
      db.prepare(`INSERT INTO purchase_orders (order_id, status) SELECT ${order}, 'received' WHERE ${full}`).bind(p.year, ...fullB),
      db.prepare(`INSERT INTO po_documents (po_id, file_id) SELECT last_insert_rowid(), ? WHERE ${full}`).bind(f.file_id, ...fullB),
    ]),
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
      SELECT 'user', ?, 'order', ${order}, 'created', json_object('order_number', ${NEW_NUMBER}, 'production_status', ?, 'from_inquiry', ?) WHERE ${full}`)
      .bind(p.actorId, p.year, p.year, p.productionStatus, p.inquiryId, ...fullB),
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
      SELECT 'user', ?, 'inquiry', ?, 'inquiry_converted', json_object('order_number', ${NEW_NUMBER}) WHERE ${full}`).bind(p.actorId, p.inquiryId, p.year, ...fullB),
    // Last: everything above read this inquiry as still new.
    db.prepare(`UPDATE inquiries SET status = 'converted', order_id = ${order}, converted_at = ${NOW}, converted_by = ?, version = version + 1 WHERE id = ? AND ${full}`)
      .bind(p.year, p.actorId, p.inquiryId, ...fullB),
  ])
  const counterAt = who.length + contact.length
  return counterN(results[counterAt])
}

/** spam, declined, or back to new after a mistake. Guarded by version; a converted or claimed inquiry can't move. */
export async function setInquiryStatus(db: D1Database, p: { id: number; version: number; actorId: number; to: 'new' | 'declined' | 'spam'; reason: string | null }) {
  const [u] = await db.batch([
    db.prepare(`UPDATE inquiries SET status = ?, decline_reason = ?, version = version + 1 WHERE id = ? AND version = ? AND status <> 'converted' AND deleting_at IS NULL AND status <> ?`)
      .bind(p.to, p.to === 'declined' ? p.reason : null, p.id, p.version, p.to),
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after)
      SELECT 'user', ?, 'inquiry', ?, 'inquiry_status', json_object('to', ?) WHERE changes() > 0`).bind(p.actorId, p.id, p.to),
  ])
  return (u?.meta.changes ?? 0) > 0
}

// ---- deletion: claim, journal, objects, rows, in that order, so a failure anywhere is retried and nothing is half gone ----

export const claimInquiry = async (db: D1Database, id: number, version: number) =>
  ((await db.prepare(`UPDATE inquiries SET deleting_at = ${NOW} WHERE id = ? AND version = ? AND status <> 'converted' AND deleting_at IS NULL`).bind(id, version).run()).meta.changes ?? 0) > 0

/** Retention claims. Spam counts from receipt, so reclassifying can't extend it. Never converted inquiries. */
export const claimExpiredInquiries = (db: D1Database, spamDays: number, unconvertedMonths: number) =>
  db.prepare(`UPDATE inquiries SET deleting_at = ${NOW} WHERE deleting_at IS NULL AND (
      (status = 'spam' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)) OR (status IN ('new','declined') AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)))`)
    .bind(`-${spamDays} days`, `-${unconvertedMonths} months`).run()

export type ClaimedInquiry = { id: number; ref: string | null; submission_id: string | null; deleting_at: string; status: InquiryStatus }
export const listClaimed = async (db: D1Database, limit: number) =>
  (await db.prepare(`SELECT id, ref, submission_id, deleting_at, status FROM inquiries WHERE deleting_at IS NOT NULL ORDER BY deleting_at LIMIT ?`).bind(limit).all<ClaimedInquiry>()).results

export const claimedFiles = async (db: D1Database, inquiryId: number) =>
  (await db.prepare(`SELECT i.id, i.r2_key, i.file_id, f.sha256 FROM inquiry_files i LEFT JOIN files f ON f.id = i.file_id WHERE i.inquiry_id = ?`).bind(inquiryId)
    .all<{ id: string; r2_key: string; file_id: number | null; sha256: string | null }>()).results

export const markClaimedFilesDeleting = (db: D1Database, inquiryId: number) =>
  db.prepare(`UPDATE inquiry_files SET status = 'deleting' WHERE inquiry_id = ? AND status = 'linked'`).bind(inquiryId).run()

/** The objects are confirmed gone. Rows go together, and the audit row carries counts only. */
export const removeClaimedRows = (db: D1Database, c: ClaimedInquiry, fileIds: number[], reason: string, actorId: number | null) => db.batch([
  db.prepare(`DELETE FROM inquiry_files WHERE inquiry_id = ?`).bind(c.id),
  ...fileIds.map((f) => db.prepare(`DELETE FROM files WHERE id = ? AND r2_key LIKE 'inquiries/%'`).bind(f)),
  db.prepare(`DELETE FROM inquiries WHERE id = ? AND deleting_at IS NOT NULL`).bind(c.id),
  ...(c.submission_id ? [db.prepare(`DELETE FROM inquiry_submissions WHERE id = ?`).bind(c.submission_id)] : []),
  db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, after) VALUES (?, ?, 'inquiry', ?, 'inquiry_deleted', ?)`)
    .bind(actorId === null ? 'system' : 'user', actorId, c.id, JSON.stringify({ reason, files: fileIds.length })),
])
