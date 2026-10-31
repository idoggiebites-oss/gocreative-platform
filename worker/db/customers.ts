// All SQL for the customers screens. Every value is bound. Every write is one db.batch(): the change plus its activity row.
import type { CustomerKind, OrderState, PaymentTerms, ProductionStatus, QuoteStatus } from '../../shared/enums'
import type { CustomerContact, CustomerDetailResponse, CustomerListRow, CustomerNote, CustomerRecord } from '../../shared/api'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`)
const changed = (r: { meta: { changes?: number } } | undefined) => (r?.meta.changes ?? 0) > 0

type CustomerRow = {
  id: number; name: string; kind: CustomerKind; organization: string | null; email: string | null; phone: string | null
  default_po_required: 0 | 1; default_payment_terms: PaymentTerms; internal_notes: string | null; created_at: string; updated_at: string; version: number
}
const CUSTOMER_COLS = 'id, name, kind, organization, email, phone, default_po_required, default_payment_terms, internal_notes, created_at, updated_at, version'
const toCustomer = (r: CustomerRow): CustomerRecord => ({
  id: r.id, name: r.name, kind: r.kind, organization: r.organization, email: r.email, phone: r.phone,
  defaultPoRequired: r.default_po_required === 1, defaultPaymentTerms: r.default_payment_terms,
  internalNotes: r.internal_notes, createdAt: r.created_at, updatedAt: r.updated_at, version: r.version,
})

type ContactRow = { id: number; name: string; email: string | null; phone: string | null; title: string | null; is_primary: 0 | 1; archived_at: string | null }
const CONTACT_COLS = 'id, name, email, phone, title, is_primary, archived_at'
const toContact = (r: ContactRow): CustomerContact => ({
  id: r.id, name: r.name, email: r.email, phone: r.phone, title: r.title,
  isPrimary: r.is_primary === 1, archived: r.archived_at !== null, archivedAt: r.archived_at,
})

export async function listCustomers(db: D1Database, p: { q?: string; kind?: CustomerKind; limit: number }): Promise<CustomerListRow[]> {
  const where: string[] = []
  const binds: (string | number)[] = []
  if (p.kind) { where.push('c.kind = ?'); binds.push(p.kind) }
  if (p.q) {
    const like = `%${likeEscape(p.q.toLowerCase())}%`
    where.push(`(lower(c.name) LIKE ? ESCAPE '\\' OR lower(c.organization) LIKE ? ESCAPE '\\' OR lower(c.email) LIKE ? ESCAPE '\\' OR lower(c.phone) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM customer_contacts k WHERE k.customer_id = c.id AND lower(k.name) LIKE ? ESCAPE '\\'))`)
    binds.push(like, like, like, like, like)
  }
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.kind, c.organization, c.email, c.phone, c.default_po_required, c.default_payment_terms,
         (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.state = 'active') AS active_orders,
         (SELECT MAX(o.created_at) FROM orders o WHERE o.customer_id = c.id) AS last_order_at
       FROM customers c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY c.name COLLATE NOCASE, c.id LIMIT ?`,
    )
    .bind(...binds, p.limit)
    .all<CustomerRow & { active_orders: number; last_order_at: string | null }>()
  return results.map((r) => ({
    id: r.id, name: r.name, kind: r.kind, organization: r.organization, email: r.email, phone: r.phone,
    defaultPoRequired: r.default_po_required === 1, defaultPaymentTerms: r.default_payment_terms,
    activeOrders: r.active_orders, outstanding: null, lastOrderAt: r.last_order_at,
  }))
}

export async function getCustomer(db: D1Database, id: number) {
  const r = await db.prepare(`SELECT ${CUSTOMER_COLS} FROM customers WHERE id = ?`).bind(id).first<CustomerRow>()
  return r ? toCustomer(r) : null
}

export async function getContact(db: D1Database, customerId: number, contactId: number) {
  const r = await db.prepare(`SELECT ${CONTACT_COLS} FROM customer_contacts WHERE id = ? AND customer_id = ?`).bind(contactId, customerId).first<ContactRow>()
  return r ? toContact(r) : null
}

export async function getCustomerDetail(db: D1Database, id: number): Promise<CustomerDetailResponse | null> {
  const customer = await getCustomer(db, id)
  if (!customer) return null
  const [contacts, orders, notes, activity] = await Promise.all([
    db.prepare(`SELECT ${CONTACT_COLS} FROM customer_contacts WHERE customer_id = ? ORDER BY archived_at IS NOT NULL, is_primary DESC, name COLLATE NOCASE, id`).bind(id).all<ContactRow>(),
    db.prepare(
      `SELECT o.number, o.title, o.production_status, o.state, o.created_at, q.status AS quote_status, q.total_cents AS quote_total
       FROM orders o LEFT JOIN quotes q ON q.id = (SELECT cq.id FROM quotes cq WHERE cq.order_id = o.id ORDER BY cq.version DESC LIMIT 1)
       WHERE o.customer_id = ? ORDER BY o.created_at DESC, o.id DESC`,
    ).bind(id).all<{ number: string; title: string; production_status: ProductionStatus; state: OrderState; created_at: string; quote_status: QuoteStatus | null; quote_total: number | null }>(),
    db.prepare(`SELECT n.id, n.body, u.name AS author_name, n.created_at FROM notes n LEFT JOIN users u ON u.id = n.author_id
        WHERE n.entity_type = 'customer' AND n.entity_id = ? ORDER BY n.id DESC`).bind(id)
      .all<{ id: number; body: string; author_name: string | null; created_at: string }>(),
    db.prepare(`SELECT a.id, COALESCE(u.name, a.actor_kind) AS actor, a.action, a.before, a.after, a.at FROM activity_log a
        LEFT JOIN users u ON u.id = a.actor_id WHERE a.entity_type = 'customer' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 50`).bind(id)
      .all<{ id: number; actor: string; action: string; before: string | null; after: string | null; at: string }>(),
  ])
  return {
    customer,
    contacts: contacts.results.map(toContact),
    orders: orders.results.map((o) => ({
      number: o.number, title: o.title, productionStatus: o.production_status, state: o.state, createdAt: o.created_at,
      quote: o.quote_status === null ? null : { status: o.quote_status, totalCents: o.quote_total ?? 0 },
    })),
    notes: notes.results.map((n) => ({ id: n.id, body: n.body, authorName: n.author_name, createdAt: n.created_at })),
    activity: activity.results.map((a) => ({
      id: a.id, actor: a.actor, action: a.action, createdAt: a.at,
      before: a.before === null ? null : JSON.parse(a.before), after: a.after === null ? null : JSON.parse(a.after),
    })),
  }
}

// Inserts only if the statement just before it changed a row (changes()), so a lost race logs nothing.
const LOG_IF_CHANGED = `INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, before, after)
  SELECT 'user', ?, 'customer', ?, ?, ?, ? WHERE changes() > 0`

type NewCustomer = {
  name: string; kind: CustomerKind; organization: string | null; email: string | null; phone: string | null
  defaultPoRequired: boolean; defaultPaymentTerms: PaymentTerms; internalNotes: string | null
}
export async function createCustomer(db: D1Database, actorId: number, c: NewCustomer) {
  const [insert] = await db.batch([
    db.prepare(`INSERT INTO customers (name, kind, organization, email, phone, default_po_required, default_payment_terms, internal_notes) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(c.name, c.kind, c.organization, c.email, c.phone, c.defaultPoRequired ? 1 : 0, c.defaultPaymentTerms, c.internalNotes),
    // The activity row needs the new id: the customer insert is the statement just before.
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, before, after)
      VALUES ('user', ?, 'customer', last_insert_rowid(), 'customer_created', NULL, ?)`)
      .bind(actorId, JSON.stringify({ name: c.name, kind: c.kind })),
  ])
  return insert!.meta.last_row_id
}

// Request field -> column. The only interpolated SQL fragments in updateCustomer come from here.
const PATCH_COLUMNS = {
  name: 'name', kind: 'kind', organization: 'organization', email: 'email', phone: 'phone',
  defaultPoRequired: 'default_po_required', defaultPaymentTerms: 'default_payment_terms', internalNotes: 'internal_notes',
} as const
export type CustomerChanges = Partial<Record<keyof typeof PATCH_COLUMNS, string | boolean | null>>

/**
 * Edits the customer, guarded by the version the caller saw. Returns false if it changed meanwhile (nothing is logged).
 * Changing defaults (or kind) only affects orders created afterwards; existing orders keep their own po_required and
 * payment_terms, so nothing here touches the orders table.
 */
export async function updateCustomer(db: D1Database, actorId: number, current: CustomerRecord, changes: CustomerChanges, expectedVersion: number) {
  const keys = (Object.keys(changes) as (keyof typeof PATCH_COLUMNS)[]).filter((k) => k in PATCH_COLUMNS)
  const bind = (v: string | boolean | null | undefined) => (typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null))
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const k of keys) { before[k] = current[k]; after[k] = changes[k] ?? null }
  const [update] = await db.batch([
    db.prepare(`UPDATE customers SET ${keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).concat(`updated_at = ${NOW}`, 'version = version + 1').join(', ')} WHERE id = ? AND version = ?`)
      .bind(...keys.map((k) => bind(changes[k])), current.id, expectedVersion),
    db.prepare(LOG_IF_CHANGED).bind(actorId, current.id, 'customer_updated', JSON.stringify(before), JSON.stringify(after)),
  ])
  return changed(update)
}

export type ContactInput = { name: string; email: string | null; phone: string | null; title: string | null }
export async function addContact(db: D1Database, actorId: number, customerId: number, c: ContactInput, isPrimary: boolean) {
  const stmts = []
  if (isPrimary) stmts.push(db.prepare('UPDATE customer_contacts SET is_primary = 0 WHERE customer_id = ?').bind(customerId))
  stmts.push(
    db.prepare('INSERT INTO customer_contacts (customer_id, name, email, phone, title, is_primary) VALUES (?,?,?,?,?,?)').bind(customerId, c.name, c.email, c.phone, c.title, isPrimary ? 1 : 0),
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, before, after)
      VALUES ('user', ?, 'customer', ?, 'contact_added', NULL, json_object('contact_id', last_insert_rowid(), 'name', ?))`).bind(actorId, customerId, c.name),
  )
  const out = await db.batch(stmts)
  return out[isPrimary ? 1 : 0]!.meta.last_row_id
}

/** Field edits; isPrimary true demotes every other contact in the same batch, false only clears this one. */
export async function updateContact(db: D1Database, actorId: number, customerId: number, current: CustomerContact, changes: Partial<ContactInput & { isPrimary: boolean }>) {
  const fields = (['name', 'email', 'phone', 'title'] as const).filter((k) => k in changes)
  const sets: string[] = fields.map((k) => `${k} = ?`)
  const vals: (string | number | null)[] = fields.map((k) => changes[k] ?? null)
  if (changes.isPrimary !== undefined) { sets.push('is_primary = ?'); vals.push(changes.isPrimary ? 1 : 0) }
  const before: Record<string, unknown> = { contact_id: current.id }
  const after: Record<string, unknown> = { contact_id: current.id }
  for (const k of [...fields, ...(changes.isPrimary !== undefined ? (['isPrimary'] as const) : [])]) { before[k] = current[k]; after[k] = changes[k] ?? null }
  const stmts = []
  // Promoting requires the target to still be active: the demote and the target UPDATE both check it, so a lost race changes nothing.
  if (changes.isPrimary) {
    stmts.push(db.prepare('UPDATE customer_contacts SET is_primary = 0 WHERE customer_id = ? AND id <> ? AND EXISTS (SELECT 1 FROM customer_contacts WHERE id = ? AND archived_at IS NULL)').bind(customerId, current.id, current.id))
  }
  stmts.push(
    db.prepare(`UPDATE customer_contacts SET ${sets.join(', ')} WHERE id = ? AND customer_id = ?${changes.isPrimary ? ' AND archived_at IS NULL' : ''}`).bind(...vals, current.id, customerId),
    db.prepare(LOG_IF_CHANGED).bind(actorId, customerId, 'contact_updated', JSON.stringify(before), JSON.stringify(after)),
  )
  const out = await db.batch(stmts)
  return changed(out[changes.isPrimary ? 1 : 0])
}

/** Archiving also drops the primary flag, so an archived contact never holds it. Returns false if the contact was already in that state. */
export async function setContactArchived(db: D1Database, actorId: number, customerId: number, contactId: number, archive: boolean) {
  const [update] = await db.batch([
    db.prepare(`UPDATE customer_contacts SET archived_at = ${archive ? NOW : 'NULL'}${archive ? ', is_primary = 0' : ''}
      WHERE id = ? AND customer_id = ? AND archived_at IS ${archive ? '' : 'NOT '}NULL`).bind(contactId, customerId),
    db.prepare(LOG_IF_CHANGED).bind(actorId, customerId, archive ? 'contact_archived' : 'contact_unarchived', null, JSON.stringify({ contact_id: contactId })),
  ])
  return changed(update)
}

export async function addNote(db: D1Database, actorId: number, customerId: number, body: string): Promise<CustomerNote> {
  const [insert] = await db.batch([
    db.prepare(`INSERT INTO notes (entity_type, entity_id, author_id, body) VALUES ('customer', ?, ?, ?)`).bind(customerId, actorId, body),
    db.prepare(`INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, before, after)
      VALUES ('user', ?, 'customer', ?, 'note_added', NULL, json_object('note_id', last_insert_rowid()))`).bind(actorId, customerId),
  ])
  const n = await db.prepare(`SELECT n.id, n.body, u.name AS author_name, n.created_at FROM notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.id = ?`)
    .bind(insert!.meta.last_row_id).first<{ id: number; body: string; author_name: string | null; created_at: string }>()
  return { id: n!.id, body: n!.body, authorName: n!.author_name, createdAt: n!.created_at }
}
