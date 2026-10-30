/// <reference types="node" />
// shared/ is typechecked with workers-types; this Node-only test pulls in node types itself.
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import * as e from './enums'

const sql = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url).pathname, 'utf8')

const enumColumns: [table: string, column: string, values: readonly string[]][] = [
  ['users', 'role', e.ROLES],
  ['customers', 'kind', e.CUSTOMER_KINDS],
  ['orders', 'source', e.ORDER_SOURCES],
  ['orders', 'state', e.ORDER_STATES],
  ['orders', 'artwork_status', e.ARTWORK_STATUSES],
  ['orders', 'production_status', e.PRODUCTION_STATUSES],
  ['order_items', 'method', e.METHODS],
  ['artwork', 'approval_status', e.APPROVAL_STATUSES],
  ['estimates', 'status', e.ESTIMATE_STATUSES],
  ['purchase_orders', 'status', e.PO_STATUSES],
  ['inquiries', 'status', e.INQUIRY_STATUSES],
]

function checkList(table: string, column: string): string[] {
  const block = sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`))?.[1]
  const list = block?.match(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`))?.[1]
  if (list === undefined) throw new Error(`no CHECK for ${table}.${column}`)
  return [...list.matchAll(/'([^']*)'/g)].map((m) => m[1])
}

describe('0001_init.sql', () => {
  it.each(enumColumns)('%s.%s CHECK matches shared/enums.ts', (table, column, values) => {
    expect(checkList(table, column)).toEqual([...values])
  })

  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(sql)
  db.exec(`
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
  it('deleting an order with a purchase order fails', () => {
    db.exec(`INSERT INTO orders (id, number, customer_id, source, title) VALUES (70, 'P-1', 1, 'phone', 't');
             INSERT INTO purchase_orders (order_id) VALUES (70);`)
    expect(() => db.exec('DELETE FROM orders WHERE id = 70')).toThrow(/FOREIGN KEY/)
  })
  it('enforces integer cents', () => {
    db.exec("INSERT INTO orders (id, number, customer_id, source, title) VALUES (71, 'P-2', 1, 'phone', 't')")
    const ins = (v: string) =>
      db.exec(`INSERT INTO order_items (order_id, product, method, quantity, unit_price_cents) VALUES (71, 'p', 'dtg', 1, ${v})`)
    expect(() => ins('1.5')).toThrow(/CHECK/)
    ins('150')
  })
  it('rejects a bogus production_status', () => {
    expect(() =>
      db.exec(`INSERT INTO orders (number, customer_id, source, title, production_status)
               VALUES ('X-1', 1, 'phone', 't', 'bogus')`),
    ).toThrow(/CHECK/)
  })
})
