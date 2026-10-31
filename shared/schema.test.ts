/// <reference types="node" />
// shared/ is typechecked with workers-types; this Node-only test pulls in node types itself.
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import * as e from './enums'

const read = (f: string) => readFileSync(new URL(`../migrations/${f}`, import.meta.url).pathname, 'utf8')
const M1 = read('0001_init.sql')
const M2 = read('0002_phase2_core.sql')
// D1 runs a migration in one transaction; defer_foreign_keys checks at its commit.
const apply = (db: DatabaseSync, sql: string) => db.exec(`BEGIN; ${sql}; COMMIT;`)
function migrated() {
  const db = new DatabaseSync(':memory:') // foreign keys on by default, like D1
  apply(db, M1)
  apply(db, M2)
  return db
}

const enumColumns: [table: string, column: string, values: readonly string[]][] = [
  ['users', 'role', e.ROLES],
  ['customers', 'kind', e.CUSTOMER_KINDS],
  ['customers', 'default_payment_terms', e.PAYMENT_TERMS],
  ['orders', 'source', e.ORDER_SOURCES],
  ['orders', 'state', e.ORDER_STATES],
  ['orders', 'production_status', e.PRODUCTION_STATUSES],
  ['orders', 'authorization_method', e.AUTHORIZATION_METHODS],
  ['orders', 'payment_terms', e.PAYMENT_TERMS],
  ['orders', 'prep_status', e.PREP_STATUSES],
  ['order_items', 'kind', e.ITEM_KINDS],
  ['order_items', 'method', e.METHODS],
  ['quotes', 'status', e.QUOTE_STATUSES],
  ['quote_items', 'kind', e.ITEM_KINDS],
  ['quote_items', 'method', e.METHODS],
  ['artwork', 'approval_status', e.ARTWORK_APPROVAL],
  ['artwork', 'approved_via', e.AUTHORIZATION_METHODS],
  ['purchase_orders', 'status', e.PO_STATUSES],
  ['inquiries', 'status', e.INQUIRY_STATUSES],
]

describe('final schema (0001 + 0002)', () => {
  const db = migrated()
  const tableSql = (table: string) => (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined)?.sql
  function checkList(table: string, column: string): string[] {
    const list = tableSql(table)?.match(new RegExp(`\\b${column} IN \\(([^)]*)\\)`))?.[1]
    if (list === undefined) throw new Error(`no CHECK for ${table}.${column}`)
    return [...list.matchAll(/'([^']*)'/g)].map((m) => m[1])
  }

  it.each(enumColumns)('%s.%s CHECK matches shared/enums.ts', (table, column, values) => {
    expect(checkList(table, column)).toEqual([...values])
  })
  it('drops what Phase 2 replaces and leaves no rebuild scaffolding', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
    expect(tables).not.toContain('estimates')
    expect(tables.filter((t) => t.startsWith('_m2_'))).toEqual([])
    const orderCols = (db.prepare('PRAGMA table_info(orders)').all() as { name: string }[]).map((c) => c.name)
    expect(orderCols).not.toContain('artwork_status')
    expect(orderCols).not.toContain('estimated_total_cents')
  })

  db.exec(`
    INSERT INTO users (id, email, name, role) VALUES (1, 'o@x', 'O', 'owner');
    INSERT INTO customers (id, kind, name) VALUES (1, 'individual', 'Test');
    INSERT INTO files (id, r2_key, mime, bytes, sha256) VALUES (1, 'k', 'image/png', 1, 'x');
    INSERT INTO activity_log (actor_kind, entity_type, entity_id, action) VALUES ('system', 'order', 1, 'x');`)

  it('files are write-once', () => {
    expect(() => db.exec("UPDATE files SET mime = 'x' WHERE id = 1")).toThrow(/write-once/)
  })
  it('activity_log is append-only', () => {
    expect(() => db.exec('DELETE FROM activity_log')).toThrow(/append-only/)
    expect(() => db.exec("UPDATE activity_log SET action = 'y'")).toThrow(/append-only/)
  })
  it('REPLACE cannot bypass write-once / append-only', () => {
    expect(() => db.exec("REPLACE INTO files (id, r2_key, mime, bytes, sha256) VALUES (1, 'k2', 'a', 1, 'x')")).toThrow(/write-once/)
    expect(() => db.exec("INSERT OR REPLACE INTO files (id, r2_key, mime, bytes, sha256) VALUES (99, 'k', 'a', 1, 'x')")).toThrow(/write-once/)
    expect(() => db.exec("REPLACE INTO activity_log (id, actor_kind, entity_type, entity_id, action) VALUES (1, 'system', 'order', 1, 'z')")).toThrow(/append-only/)
    db.exec("INSERT INTO files (r2_key, mime, bytes, sha256) VALUES ('new', 'a', 1, 'x')")
    db.exec("INSERT INTO activity_log (actor_kind, entity_type, entity_id, action) VALUES ('system', 'order', 1, 'y')")
  })
  it('deleting a user referenced by activity_log hits the FK, not a trigger', () => {
    db.exec("INSERT INTO users (id, email, name, role) VALUES (50, 'u@x.com', 'U', 'staff')")
    db.exec("INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action) VALUES ('user', 50, 'order', 1, 'x')")
    expect(() => db.exec('DELETE FROM users WHERE id = 50')).toThrow(/FOREIGN KEY/)
  })
  it('deleting an order with a purchase order or a quote fails', () => {
    db.exec(`INSERT INTO orders (id, number, customer_id, source, title) VALUES (70, 'P-1', 1, 'phone', 't'), (72, 'P-3', 1, 'phone', 't');
             INSERT INTO purchase_orders (order_id) VALUES (70);
             INSERT INTO quotes (order_id, version, items_revision, created_by) VALUES (72, 1, 0, 1);`)
    expect(() => db.exec('DELETE FROM orders WHERE id = 70')).toThrow(/FOREIGN KEY/)
    expect(() => db.exec('DELETE FROM orders WHERE id = 72')).toThrow(/FOREIGN KEY/)
  })
  it('enforces integer cents and product lines with a product and method', () => {
    db.exec("INSERT INTO orders (id, number, customer_id, source, title) VALUES (71, 'P-2', 1, 'phone', 't')")
    const ins = (v: string) =>
      db.exec(`INSERT INTO order_items (order_id, product, method, quantity, unit_price_cents) VALUES (71, 'p', 'dtg', 1, ${v})`)
    expect(() => ins('1.5')).toThrow(/CHECK/)
    ins('150')
    expect(() => db.exec("INSERT INTO order_items (order_id, kind, quantity, unit_price_cents) VALUES (71, 'product', 1, 1)")).toThrow(/CHECK/)
    db.exec("INSERT INTO order_items (order_id, kind, description, quantity, unit_price_cents) VALUES (71, 'charge', 'Rush', 1, 500)")
  })
  it('rejects a bogus or Phase 1 production_status and state', () => {
    for (const bad of [`production_status`, `state`]) {
      expect(() => db.exec(`INSERT INTO orders (number, customer_id, source, title, ${bad}) VALUES ('X-1', 1, 'phone', 't', 'completed')`)).toThrow(/CHECK/)
    }
    const row = db.prepare("INSERT INTO orders (number, customer_id, source, title) VALUES ('X-2', 1, 'phone', 't') RETURNING production_status, state, artwork_required, materials_required, prep_status, payment_terms, items_revision").get()
    expect(row).toEqual({ production_status: 'awaiting_quote', state: 'active', artwork_required: 1, materials_required: 1, prep_status: 'not_started', payment_terms: 'due_at_pickup', items_revision: 0 })
  })
  it('an approved artwork version records when, how and by whom', () => {
    db.exec("INSERT INTO artwork (id, customer_id, lineage_id, version, file_id) VALUES (1, 1, 1, 1, 1)")
    expect(() => db.exec("UPDATE artwork SET approval_status = 'approved' WHERE id = 1")).toThrow(/CHECK/)
    db.exec("UPDATE artwork SET approval_status = 'approved', approved_at = '2026-10-30T00:00:00Z', approved_via = 'email', approval_recorded_by = 1 WHERE id = 1")
  })
})

describe('quote immutability triggers', () => {
  function setup() {
    const db = migrated()
    db.exec(`INSERT INTO users (id, email, name, role) VALUES (1, 'o@x', 'O', 'owner');
      INSERT INTO customers (id, kind, name) VALUES (1, 'individual', 'C');
      INSERT INTO orders (id, number, customer_id, source, title, items_revision) VALUES (1, 'Q-1', 1, 'phone', 't', 1);`)
    const quote = (id: number, version: number, lines: ('product' | 'charge')[] = ['product']) => {
      db.exec(`INSERT INTO quotes (id, order_id, version, items_revision, created_by) VALUES (${id}, 1, ${version}, 1, 1)`)
      lines.forEach((kind, i) => db.exec(kind === 'product'
        ? `INSERT INTO quote_items (id, quote_id, position, kind, product, method, quantity, unit_price_cents, line_total_cents) VALUES (${id * 10 + i}, ${id}, ${i}, 'product', 'Tee', 'screen', 2, 500, 1000)`
        : `INSERT INTO quote_items (id, quote_id, position, kind, description, quantity, unit_price_cents, line_total_cents) VALUES (${id * 10 + i}, ${id}, ${i}, 'charge', 'Rush', 1, 300, 300)`))
      db.exec(`UPDATE quotes SET subtotal_cents = ${lines.filter((l) => l === 'product').length * 1000}, charges_cents = ${lines.filter((l) => l === 'charge').length * 300},
        total_cents = ${lines.filter((l) => l === 'product').length * 1000 + lines.filter((l) => l === 'charge').length * 300} WHERE id = ${id}`)
    }
    const status = (id: number) => (db.prepare('SELECT status FROM quotes WHERE id = ?').get(id) as { status: string }).status
    return { db, quote, status }
  }

  it('a draft is fully editable; once sent or accepted its lines are frozen against every write path', () => {
    const { db, quote } = setup()
    quote(1, 1)
    db.exec('UPDATE quote_items SET quantity = 3, line_total_cents = 1500 WHERE id = 10')
    db.exec('UPDATE quotes SET items_revision = 1, subtotal_cents = 1500, total_cents = 1500 WHERE id = 1')
    for (const to of ['sent', 'accepted']) {
      db.exec(`UPDATE quotes SET status = '${to}' WHERE id = 1`)
      expect(() => db.exec('UPDATE quote_items SET unit_price_cents = 1 WHERE id = 10')).toThrow(/quote_not_draft/)
      expect(() => db.exec('DELETE FROM quote_items WHERE id = 10')).toThrow(/quote_not_draft/)
      expect(() => db.exec(`INSERT INTO quote_items (quote_id, position, kind, description, quantity, unit_price_cents, line_total_cents) VALUES (1, 5, 'charge', 'x', 1, 1, 1)`)).toThrow(/quote_not_draft/)
      // REPLACE fires no DELETE trigger, so it is refused at insert time, by id or by (quote, position).
      quote(to === 'sent' ? 2 : 3, to === 'sent' ? 2 : 3)
      const draft = to === 'sent' ? 2 : 3
      expect(() => db.exec(`REPLACE INTO quote_items (id, quote_id, position, kind, product, method, quantity, unit_price_cents, line_total_cents) VALUES (10, ${draft}, 9, 'product', 'X', 'dtg', 1, 1, 1)`)).toThrow(/quote_not_draft/)
      expect(() => db.exec(`INSERT OR REPLACE INTO quote_items (quote_id, position, kind, product, method, quantity, unit_price_cents, line_total_cents) VALUES (1, 0, 'product', 'X', 'dtg', 1, 1, 1)`)).toThrow(/quote_not_draft/)
      // Moving a draft line onto a frozen quote, or a frozen line off it.
      expect(() => db.exec(`UPDATE quote_items SET quote_id = 1, position = 7 WHERE quote_id = ${draft}`)).toThrow(/quote_not_draft/)
      expect(() => db.exec(`UPDATE quote_items SET quote_id = ${draft}, position = 8 WHERE id = 10`)).toThrow(/quote_not_draft/)
      expect(() => db.exec(`UPDATE OR REPLACE quote_items SET id = 10 WHERE quote_id = ${draft}`)).toThrow(/quote_not_draft/)
      expect(db.prepare('SELECT quantity, unit_price_cents FROM quote_items WHERE id = 10').get()).toEqual({ quantity: 3, unit_price_cents: 500 })
      db.exec(`UPDATE quotes SET status = 'superseded' WHERE id = ${draft}`)
    }
  })
  it('once out of draft only status, sent_at and decided_at change', () => {
    const { db, quote } = setup()
    quote(1, 1)
    db.exec("UPDATE quotes SET status = 'sent', sent_at = '2026-10-01T00:00:00Z' WHERE id = 1")
    db.exec("UPDATE quotes SET sent_at = '2026-10-02T00:00:00Z' WHERE id = 1")
    for (const set of ['total_cents = 1, subtotal_cents = 1', 'items_revision = 2', 'version = 9', 'order_id = 1, version = 5', 'created_by = 1, created_at = 1', 'id = 99']) {
      expect(() => db.exec(`UPDATE quotes SET ${set} WHERE id = 1`), set).toThrow(/quote_frozen/)
    }
    db.exec("UPDATE quotes SET status = 'accepted', decided_at = '2026-10-03T00:00:00Z' WHERE id = 1")
    expect(() => db.exec('DELETE FROM quotes WHERE id = 1')).toThrow(/quote_not_draft/)
    expect(() => db.exec("REPLACE INTO quotes (id, order_id, version, items_revision, created_by) VALUES (1, 1, 1, 1, 1)")).toThrow(/quote_not_draft/)
  })
  it('UPDATE OR REPLACE cannot move a draft onto a frozen version and delete it', () => {
    for (const status of ['sent', 'declined', 'superseded']) {
      const { db, quote } = setup()
      quote(1, 1, []) // Codex's case: an empty quote that has left draft
      db.exec(`UPDATE quotes SET status = '${status}' WHERE id = 1`)
      quote(2, 2)
      expect(() => db.exec('UPDATE OR REPLACE quotes SET version = 1 WHERE order_id = 1 AND version = 2'), status).toThrow(/quote_frozen/)
      expect(db.prepare('SELECT status FROM quotes WHERE order_id = 1 AND version = 1').get(), status).toEqual({ status })
    }
  })
  it('an authorization timestamp is never blank', () => {
    const { db } = setup()
    for (const v of ["''", "'   '"]) expect(() => db.exec(`UPDATE orders SET authorized_at = ${v} WHERE id = 1`), v).toThrow(/CHECK/)
  })
  it('allows exactly the transitions checkQuoteTransition and planNewVersion make', () => {
    const allowed: Record<string, string[]> = {
      draft: ['sent', 'accepted', 'declined', 'superseded'], sent: ['accepted', 'declined', 'superseded'], accepted: ['superseded'], declined: [], superseded: [],
    }
    const path: Record<string, string[]> = { draft: [], sent: ['sent'], accepted: ['accepted'], declined: ['declined'], superseded: ['superseded'] }
    let id = 1
    for (const from of e.QUOTE_STATUSES) for (const to of e.QUOTE_STATUSES) {
      if (from === to) continue
      const { db, quote, status } = setup()
      quote(id, 1)
      for (const step of path[from]) db.exec(`UPDATE quotes SET status = '${step}' WHERE id = ${id}`)
      const run = () => db.exec(`UPDATE quotes SET status = '${to}' WHERE id = ${id}`)
      if (allowed[from].includes(to)) { run(); expect(status(id)).toBe(to) } else expect(run, `${from} -> ${to}`).toThrow(/invalid_quote_transition/)
      id++
    }
  })
  it('a quote is inserted as a draft, never accepted without a product line, and one accepted per order', () => {
    const { db, quote } = setup()
    expect(() => db.exec("INSERT INTO quotes (order_id, version, status, items_revision, created_by) VALUES (1, 1, 'accepted', 1, 1)")).toThrow(/quote_not_draft/)
    quote(1, 1, ['charge'])
    expect(() => db.exec("UPDATE quotes SET status = 'accepted' WHERE id = 1")).toThrow(/no_product_line/)
    db.exec("UPDATE quotes SET status = 'sent' WHERE id = 1")
    expect(() => db.exec("UPDATE quotes SET status = 'accepted' WHERE id = 1")).toThrow(/no_product_line/)
    quote(2, 2, ['product', 'charge'])
    db.exec("UPDATE quotes SET status = 'accepted' WHERE id = 2")
    quote(3, 3)
    expect(() => db.exec("UPDATE quotes SET status = 'accepted' WHERE id = 3")).toThrow(/UNIQUE/)
    db.exec("UPDATE quotes SET status = 'superseded' WHERE id = 2")
    db.exec("UPDATE quotes SET status = 'accepted' WHERE id = 3")
  })
})

describe('0002 applies on top of 0001', () => {
  it('on a database holding only users (the remote after the wipe)', () => {
    const db = new DatabaseSync(':memory:')
    apply(db, M1)
    db.exec("INSERT INTO users (id, email, name, role) VALUES (1, 'a@x', 'A', 'owner'), (2, 'b@x', 'B', 'owner')")
    apply(db, M2)
    expect(db.prepare('SELECT id, email FROM users ORDER BY id').all()).toEqual([{ id: 1, email: 'a@x' }, { id: 2, email: 'b@x' }])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  })
  it('on Phase 1 data: every row and link survives, every old value maps onto the new vocabulary', () => {
    const db = new DatabaseSync(':memory:')
    apply(db, M1)
    const states = ['awaiting_authorization', 'awaiting_artwork', 'ready', 'in_production', 'quality_control', 'ready_for_pickup', 'completed']
    db.exec(`INSERT INTO users (id, email, name, role) VALUES (1, 'a@x', 'A', 'owner');
      INSERT INTO customers (id, kind, name) VALUES (1, 'district', 'D');
      INSERT INTO customer_contacts (id, customer_id, name) VALUES (1, 1, 'P');
      INSERT INTO files (id, r2_key, mime, bytes, sha256) VALUES (1, 'a', 'image/png', 1, 'x'), (2, 'b', 'application/pdf', 1, 'y');
      ${states.map((s, i) => `INSERT INTO orders (id, number, customer_id, contact_id, source, title, artwork_status, po_required, production_status, estimated_total_cents, state, authorized_at, authorized_by)
        VALUES (${i + 1}, '2026-000${i + 1}', 1, 1, 'phone', 't${i}', 'approved', ${i % 2}, '${s}', 100, '${s === 'completed' ? 'completed' : i === 2 ? 'cancelled' : 'active'}', '2026-01-01T00:00:00Z', 1);`).join('\n')}
      INSERT INTO order_items (id, order_id, product, method, sizes, quantity, unit_price_cents, notes) VALUES (1, 1, 'Tee', 'screen', '{"M":2}', 2, 500, 'n'), (2, 4, 'Mug', 'laser_engrave', NULL, 1, 900, NULL);
      INSERT INTO artwork (id, customer_id, order_id, lineage_id, version, file_id, approval_status) VALUES (1, 1, 1, 1, 1, 1, 'pending'), (2, 1, 1, 1, 2, 1, 'approved'), (3, 1, 2, 3, 1, 1, 'changes_requested');
      INSERT INTO estimates (order_id, version, inputs, lines, total_cents, status) VALUES (1, 1, '{}', '[]', 100, 'accepted');
      INSERT INTO purchase_orders (id, order_id, po_number, status) VALUES (1, 2, 'PO-1', 'approved'), (2, 4, 'PO-2', 'under_review');
      INSERT INTO po_documents (id, po_id, file_id) VALUES (1, 1, 2);
      INSERT INTO inquiries (id, payload, order_id, status) VALUES (1, '{}', 5, 'converted'), (2, '{}', NULL, 'new');
      INSERT INTO notes (entity_type, entity_id, author_id, body) VALUES ('order', 1, 1, 'kept');
      INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action) VALUES ('user', 1, 'order', 1, 'created');
      INSERT INTO counters (name, year, next) VALUES ('order', 2026, 8);`)
    apply(db, M2)
    const all = (sql: string) => db.prepare(sql).all()
    expect(all('SELECT id, production_status, state, po_required, contact_id, authorized_by FROM orders ORDER BY id')).toEqual([
      { id: 1, production_status: 'awaiting_quote', state: 'active', po_required: 0, contact_id: 1, authorized_by: 1 },
      { id: 2, production_status: 'awaiting_quote', state: 'active', po_required: 1, contact_id: 1, authorized_by: 1 },
      { id: 3, production_status: 'awaiting_quote', state: 'cancelled', po_required: 0, contact_id: 1, authorized_by: 1 },
      { id: 4, production_status: 'in_production', state: 'active', po_required: 1, contact_id: 1, authorized_by: 1 },
      { id: 5, production_status: 'quality_control', state: 'active', po_required: 0, contact_id: 1, authorized_by: 1 },
      { id: 6, production_status: 'production_complete', state: 'active', po_required: 1, contact_id: 1, authorized_by: 1 },
      { id: 7, production_status: 'production_complete', state: 'closed', po_required: 0, contact_id: 1, authorized_by: 1 },
    ])
    expect(all('SELECT id, order_id, kind, product, sizes, notes FROM order_items ORDER BY id')).toEqual([
      { id: 1, order_id: 1, kind: 'product', product: 'Tee', sizes: '{"M":2}', notes: 'n' },
      { id: 2, order_id: 4, kind: 'product', product: 'Mug', sizes: null, notes: null },
    ])
    expect(all('SELECT id, order_id, approval_status FROM artwork ORDER BY id')).toEqual([
      { id: 1, order_id: 1, approval_status: 'under_review' }, { id: 2, order_id: 1, approval_status: 'under_review' }, { id: 3, order_id: 2, approval_status: 'changes_requested' },
    ])
    expect(all('SELECT id, order_id, status FROM purchase_orders ORDER BY id')).toEqual([{ id: 1, order_id: 2, status: 'approved' }, { id: 2, order_id: 4, status: 'under_review' }])
    expect(all('SELECT po_id, file_id FROM po_documents')).toEqual([{ po_id: 1, file_id: 2 }])
    // ON DELETE SET NULL / CASCADE never fired: the links are intact.
    expect(all('SELECT id, order_id FROM inquiries ORDER BY id')).toEqual([{ id: 1, order_id: 5 }, { id: 2, order_id: null }])
    expect(all('SELECT COUNT(*) AS n FROM notes')).toEqual([{ n: 1 }])
    expect(all('SELECT COUNT(*) AS n FROM activity_log')).toEqual([{ n: 1 }])
    expect(all('SELECT COUNT(*) AS n FROM quotes')).toEqual([{ n: 0 }])
    expect(all('PRAGMA foreign_key_check')).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  })
  it('rolls back completely when it fails part-way', () => {
    const db = new DatabaseSync(':memory:')
    apply(db, M1)
    const broken = M2.replace('DROP TABLE _m2_orders;', 'DROP TABLE _m2_orders; INSERT INTO no_such_table VALUES (1);')
    expect(() => apply(db, broken)).toThrow()
    db.exec('ROLLBACK')
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'estimates'").get()).toEqual({ n: 1 })
  })
})
