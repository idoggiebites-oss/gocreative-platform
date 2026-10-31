// SQL for files, artwork versions, purchase orders and PO documents (M2a). Every write is one orderWrite batch:
// its data statements carry GUARD (the client's order version), then the order UPDATE bumps the version, logs and
// re-derives. Values are bound; the interpolated fragments are constants.
import type { ArtworkApproval, AuthorizationMethod, PoStatus } from '../../shared/enums'
import type { ArtworkDesign, PurchaseOrderRecord, UploadedFile } from '../../shared/api'
import { GUARD, orderWriteResults, type Stmt } from './orders'

type Guarded = { orderId: number; version: number; actorId: number }
export type NewFile = { r2Key: string; mime: string; bytes: number; sha256: string; filename: string | null }

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
const FILE_ID = `(SELECT id FROM files WHERE r2_key = ?)`
const insertFile = (db: D1Database, p: Guarded & { file: NewFile }): Stmt =>
  db.prepare(`INSERT INTO files (r2_key, mime, bytes, sha256, uploaded_by, filename) SELECT ?, ?, ?, ?, ?, ? WHERE ${GUARD}`)
    .bind(p.file.r2Key, p.file.mime, p.file.bytes, p.file.sha256, p.actorId, p.file.filename, p.orderId, p.version)
const newId = (r: { results?: unknown[] } | undefined) => (r?.results?.[0] as { id: number } | undefined)?.id ?? null

/**
 * A file as a new design (lineageId omitted: the next free lineage id, version 1) or as the next version of one of
 * this order's designs, which copies the design's name. Every new version starts under_review, so a re-upload after
 * approval needs approval again (§4). For a lineage that isn't on this order the version subquery is NULL and the
 * NOT NULL constraint aborts the whole batch, so a file row can never be left behind without its artwork row.
 * Returns null when the order version was stale (nothing written).
 */
export async function uploadArtwork(db: D1Database, p: Guarded & { file: NewFile; lineageId?: number; designName: string | null; nextVersion: number }) {
  const artwork = p.lineageId === undefined
    ? db.prepare(`INSERT INTO artwork (customer_id, order_id, lineage_id, version, file_id, design_name)
        SELECT o.customer_id, o.id, (SELECT COALESCE(MAX(lineage_id), 0) + 1 FROM artwork), 1, ${FILE_ID}, ? FROM orders o WHERE o.id = ? AND o.version = ?
        RETURNING id`).bind(p.file.r2Key, p.designName, p.orderId, p.version)
    : db.prepare(`INSERT INTO artwork (customer_id, order_id, lineage_id, version, file_id, design_name)
        SELECT o.customer_id, o.id, ?1, (SELECT MAX(b.version) + 1 FROM artwork b WHERE b.lineage_id = ?1 AND b.order_id = o.id),
          (SELECT id FROM files WHERE r2_key = ?2),
          (SELECT b.design_name FROM artwork b WHERE b.lineage_id = ?1 AND b.order_id = o.id ORDER BY b.version DESC LIMIT 1)
        FROM orders o WHERE o.id = ?3 AND o.version = ?4 RETURNING id`).bind(p.lineageId, p.file.r2Key, p.orderId, p.version)
  const { state, data } = await orderWriteResults(db, {
    ...p, action: 'artwork_uploaded', data: [insertFile(db, p), artwork],
    after: { ...(p.lineageId === undefined ? {} : { lineage_id: p.lineageId }), artwork_version: p.nextVersion, ...(p.designName ? { design_name: p.designName } : {}) },
  })
  const id = newId(data[1])
  return state && id !== null ? { state, id } : null
}

export type ArtworkRow = { id: number; lineage_id: number; version: number; approval_status: ArtworkApproval; is_current: 0 | 1 }
export const getArtworkVersion = (db: D1Database, orderId: number, artworkId: number) =>
  db.prepare(`SELECT a.id, a.lineage_id, a.version, a.approval_status,
      a.version = (SELECT MAX(b.version) FROM artwork b WHERE b.lineage_id = a.lineage_id AND b.order_id = a.order_id) AS is_current
      FROM artwork a WHERE a.id = ? AND a.order_id = ?`).bind(artworkId, orderId).first<ArtworkRow>()
/** The current version of one of this order's designs, or null when the design isn't on this order. */
export const getDesignHead = (db: D1Database, orderId: number, lineageId: number) =>
  db.prepare(`SELECT version, design_name FROM artwork WHERE lineage_id = ? AND order_id = ? ORDER BY version DESC LIMIT 1`).bind(lineageId, orderId)
    .first<{ version: number; design_name: string | null }>()

/**
 * Records the customer's decision on a version. The UPDATE re-asserts what the route checked (still this status,
 * still the current version, the client's order version). Approval fills when/how/who (0002's CHECK requires them);
 * changes_requested clears them and keeps the file. The note is internal: it goes on the version, not in the log.
 */
export async function decideArtwork(db: D1Database, p: Guarded & { artwork: ArtworkRow; to: 'approved' | 'changes_requested'; via: AuthorizationMethod | null; note: string | null }) {
  const a = p.artwork
  const approved = p.to === 'approved'
  const { state } = await orderWriteResults(db, {
    ...p, action: 'artwork_decided',
    data: [db.prepare(`UPDATE artwork SET approval_status = ?, approved_at = ${approved ? NOW : 'NULL'}, approved_via = ?, approval_recorded_by = ?,
        notes = COALESCE(?, notes)
        WHERE id = ? AND order_id = ? AND approval_status = ?
          AND version = (SELECT MAX(b.version) FROM artwork b WHERE b.lineage_id = artwork.lineage_id AND b.order_id = artwork.order_id) AND ${GUARD}`)
      .bind(p.to, approved ? p.via : null, approved ? p.actorId : null, p.note, a.id, p.orderId, a.approval_status, p.orderId, p.version)],
    // The order UPDATE applies only if the artwork row did, so a lost race logs and bumps nothing.
    where: ['changes() > 0'],
    before: { artwork_id: a.id, lineage_id: a.lineage_id, artwork_version: a.version, approval_status: a.approval_status },
    after: { artwork_id: a.id, lineage_id: a.lineage_id, artwork_version: a.version, approval_status: p.to, ...(approved ? { approved_via: p.via } : {}) },
  })
  return state
}

// ---- purchase orders ----

export async function createPurchaseOrder(db: D1Database, p: Guarded & { poNumber: string | null; amountCents: number | null }) {
  const { state, data } = await orderWriteResults(db, {
    ...p, action: 'po_created',
    data: [db.prepare(`INSERT INTO purchase_orders (order_id, po_number, amount_cents) SELECT ?, ?, ? WHERE ${GUARD} RETURNING id`)
      .bind(p.orderId, p.poNumber, p.amountCents, p.orderId, p.version)],
    after: { po_status: 'requested', po_number: p.poNumber, amount_cents: p.amountCents },
  })
  const id = newId(data[0])
  return state && id !== null ? { state, id } : null
}

export const getPurchaseOrder = (db: D1Database, orderId: number, poId: number) =>
  db.prepare('SELECT id, po_number, amount_cents, status FROM purchase_orders WHERE id = ? AND order_id = ?').bind(poId, orderId)
    .first<{ id: number; po_number: string | null; amount_cents: number | null; status: PoStatus }>()

export async function updatePurchaseOrderDetails(db: D1Database, p: Guarded & {
  poId: number; before: { poNumber: string | null; amountCents: number | null }; after: { poNumber: string | null; amountCents: number | null }
}) {
  const { state } = await orderWriteResults(db, {
    ...p, action: 'po_details_updated',
    data: [db.prepare(`UPDATE purchase_orders SET po_number = ?, amount_cents = ?, updated_at = ${NOW} WHERE id = ? AND order_id = ? AND ${GUARD}`)
      .bind(p.after.poNumber, p.after.amountCents, p.poId, p.orderId, p.orderId, p.version)],
    where: ['changes() > 0'],
    before: { po_id: p.poId, po_number: p.before.poNumber, amount_cents: p.before.amountCents },
    after: { po_id: p.poId, po_number: p.after.poNumber, amount_cents: p.after.amountCents },
  })
  return state
}

/** A PO document is always a new row: a corrected document is added next to the old one, never over it. */
export async function addPoDocument(db: D1Database, p: Guarded & { poId: number; file: NewFile }) {
  const { state, data } = await orderWriteResults(db, {
    ...p, action: 'po_document_added',
    data: [
      insertFile(db, p),
      // A PO that isn't this order's gives po_id NULL, which fails NOT NULL and aborts the whole batch (file row included).
      db.prepare(`INSERT INTO po_documents (po_id, file_id) SELECT (SELECT p.id FROM purchase_orders p WHERE p.id = ? AND p.order_id = ?), ${FILE_ID}
          WHERE ${GUARD} RETURNING id`)
        .bind(p.poId, p.orderId, p.file.r2Key, p.orderId, p.version),
    ],
    after: { po_id: p.poId },
  })
  const id = newId(data[1])
  return state && id !== null ? { state, id } : null
}

// ---- reads ----

type FileCols = { file_id: number; filename: string | null; mime: string; bytes: number; uploaded_by_name: string | null; uploaded_at: string }
const FILE_SELECT = `f.id AS file_id, f.filename, f.mime, f.bytes, uf.name AS uploaded_by_name, f.created_at AS uploaded_at`
const toFile = (r: FileCols): UploadedFile => ({ id: r.file_id, filename: r.filename, mime: r.mime, bytes: r.bytes, uploadedBy: r.uploaded_by_name, uploadedAt: r.uploaded_at })

/** Designs (lineages) with every version newest first, for one order or across all of a customer's orders. */
export async function listDesigns(db: D1Database, by: { orderId: number } | { customerId: number }): Promise<ArtworkDesign[]> {
  const { results } = await db.prepare(`SELECT a.id, a.lineage_id, a.version, a.design_name, a.approval_status, a.approved_at, a.approved_via,
        ur.name AS recorded_by_name, a.notes, a.created_at, o.number AS order_number, ${FILE_SELECT}
      FROM artwork a JOIN orders o ON o.id = a.order_id JOIN files f ON f.id = a.file_id
      LEFT JOIN users uf ON uf.id = f.uploaded_by LEFT JOIN users ur ON ur.id = a.approval_recorded_by
      WHERE ${'orderId' in by ? 'a.order_id' : 'o.customer_id'} = ?
      ORDER BY o.id DESC, a.lineage_id, a.version DESC`)
    .bind('orderId' in by ? by.orderId : by.customerId)
    .all<FileCols & { id: number; lineage_id: number; version: number; design_name: string | null; approval_status: ArtworkApproval; approved_at: string | null
      approved_via: AuthorizationMethod | null; recorded_by_name: string | null; notes: string | null; created_at: string; order_number: string }>()
  const designs = new Map<string, ArtworkDesign>()
  for (const r of results) {
    const key = `${r.order_number}/${r.lineage_id}`
    const d = designs.get(key) ?? { lineageId: r.lineage_id, name: r.design_name, orderNumber: r.order_number, versions: [] }
    designs.set(key, d)
    d.versions.push({
      id: r.id, version: r.version, approvalStatus: r.approval_status, approvedAt: r.approved_at, approvedVia: r.approved_via,
      approvalRecordedBy: r.recorded_by_name, notes: r.notes, createdAt: r.created_at, file: toFile(r),
    })
  }
  return [...designs.values()]
}

export async function listPoDocuments(db: D1Database, orderId: number) {
  const { results } = await db.prepare(`SELECT d.id, d.po_id, ${FILE_SELECT} FROM po_documents d JOIN purchase_orders p ON p.id = d.po_id
      JOIN files f ON f.id = d.file_id LEFT JOIN users uf ON uf.id = f.uploaded_by WHERE p.order_id = ? ORDER BY d.id DESC`).bind(orderId)
    .all<FileCols & { id: number; po_id: number }>()
  const out = new Map<number, PurchaseOrderRecord['documents']>()
  for (const r of results) out.set(r.po_id, [...(out.get(r.po_id) ?? []), { id: r.id, file: toFile(r) }])
  return out
}

export async function listPurchaseOrders(db: D1Database, orderId: number): Promise<PurchaseOrderRecord[]> {
  const [pos, docs] = await Promise.all([
    db.prepare('SELECT id, po_number, amount_cents, status, created_at, updated_at FROM purchase_orders WHERE order_id = ? ORDER BY id DESC').bind(orderId)
      .all<{ id: number; po_number: string | null; amount_cents: number | null; status: PoStatus; created_at: string; updated_at: string }>(),
    listPoDocuments(db, orderId),
  ])
  return pos.results.map((p) => ({
    id: p.id, poNumber: p.po_number, amountCents: p.amount_cents, status: p.status, createdAt: p.created_at, updatedAt: p.updated_at, documents: docs.get(p.id) ?? [],
  }))
}

/** A file only when an artwork version on an order, or a PO document, links it: an unlinked file is never served. */
export const getLinkedFile = (db: D1Database, fileId: number) =>
  db.prepare(`SELECT f.id, f.r2_key, f.mime, f.filename FROM files f WHERE f.id = ?1
      AND (EXISTS (SELECT 1 FROM artwork a WHERE a.file_id = f.id AND a.order_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM po_documents d JOIN purchase_orders p ON p.id = d.po_id WHERE d.file_id = f.id))`).bind(fileId)
    .first<{ id: number; r2_key: string; mime: string; filename: string | null }>()

export const customerExists = async (db: D1Database, id: number) =>
  (await db.prepare('SELECT 1 AS ok FROM customers WHERE id = ?').bind(id).first<{ ok: number }>()) !== null
