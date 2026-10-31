import { expect, test } from 'vitest'
import { ARTWORK_APPROVAL, ORDER_STATES, PO_STATUSES, PREP_STATUSES, QUOTE_STATUSES } from '../../shared/enums'
import type { ArtworkApproval, OrderState, PoStatus, PrepStatus, PurchaseStoredStatus, QuoteStatus } from '../../shared/enums'
import { orderArtworkStatus, readiness, type ReadinessInput } from '../../worker/domain/readiness'
import { ARTWORK_STATUS, GATE_OK, PRE_PRODUCTION, getOrderByNumber, readinessInput } from '../../worker/db/orders'
import { createTestD1 } from './d1'

// Readiness exists twice: in worker/domain (what the UI and routes check) and as SQL in worker/db/orders.ts
// (re-asserted inside the writes, so a concurrent change can't slip past). This builds one order per case
// from real rows and fails if the SQL, the domain, or the DB loader that feeds the domain ever disagree.
//
// The space: the full option list of each readiness item, against a background where every other item is
// met and one where none is, in every order state; plus every met/unmet combination of the five items.
// The full cartesian product (~400k orders) adds nothing the SQL's shape could hide: GATE_OK is an AND of
// the five items and PRE_PRODUCTION the first unmet one, each item reading its own columns and rows.

type Quote = { status: QuoteStatus; match: boolean; products: 0 | 1; prior: boolean } | null
type Artwork = { required: boolean; designs: ArtworkApproval[][] } // each design: its versions, oldest first
type Auth = { poRequired: boolean; po: PoStatus | null; authorized: boolean }
// Each purchase: its stored status, quantity and receipt quantities (recorded while ordered, then cancelled if so).
type Purchase = { status: PurchaseStoredStatus; quantity: number; receipts: number[] }
type Materials = { required: boolean; purchases: Purchase[] }
type Case = { state: OrderState; quote: Quote; artwork: Artwork; auth: Auth; materials: Materials; prep: PrepStatus }

const quotes: Quote[] = [null]
for (const status of QUOTE_STATUSES) for (const match of [true, false]) for (const products of [0, 1] as const) for (const prior of [false, true]) quotes.push({ status, match, products, prior })
const designSets: ArtworkApproval[][][] = [
  [], ...ARTWORK_APPROVAL.map((a) => [[a]]),
  [['approved'], ['under_review']], [['approved'], ['changes_requested']], [['under_review'], ['changes_requested']], [['approved'], ['approved']],
  // Only the current (highest) version counts.
  [['approved', 'under_review']], [['changes_requested', 'approved']],
]
const artworks: Artwork[] = [true, false].flatMap((required) => designSets.map((designs) => ({ required, designs })))
const auths: Auth[] = [false, true].flatMap((poRequired) => [null, ...PO_STATUSES].flatMap((po) => [false, true].map((authorized) => ({ poRequired, po, authorized }))))

const P = (status: PurchaseStoredStatus, quantity: number, ...receipts: number[]): Purchase => ({ status, quantity, receipts })
const purchaseSets: Purchase[][] = [
  [], [P('not_ordered', 10)],
  [P('ordered', 10)], [P('ordered', 10, 4)], [P('ordered', 10, 4, 6)], [P('ordered', 10, 12)],
  // Cancelled-only counts as no purchase; a cancelled one's receipts never satisfy anything else.
  [P('cancelled', 10)], [P('cancelled', 10, 3)],
  [P('cancelled', 10), P('ordered', 5, 5)], [P('cancelled', 10, 2), P('ordered', 5, 2, 3)], [P('cancelled', 10, 10), P('ordered', 5, 4)],
  // One unmet purchase blocks the rest, including one not ordered yet.
  [P('ordered', 5, 5), P('not_ordered', 3)], [P('ordered', 5, 5), P('ordered', 5, 1)], [P('ordered', 5, 9), P('ordered', 5, 1)],
]
const materialsSets: Materials[] = [true, false].flatMap((required) => purchaseSets.map((purchases) => ({ required, purchases })))

const ok = { quote: { status: 'accepted', match: true, products: 1, prior: false } as Quote, artwork: { required: true, designs: [['approved']] } as Artwork,
  auth: { poRequired: false, po: null, authorized: true } as Auth, materials: { required: true, purchases: [P('ordered', 10, 10)] } as Materials, prep: 'ready' as PrepStatus }
const bad = { quote: null as Quote, artwork: { required: true, designs: [] } as Artwork,
  auth: { poRequired: true, po: null, authorized: true } as Auth, materials: { required: true, purchases: [] } as Materials, prep: 'not_started' as PrepStatus }
const options = { quote: quotes, artwork: artworks, auth: auths, materials: materialsSets, prep: [...PREP_STATUSES] }

const cases: Case[] = []
for (const state of ORDER_STATES) {
  for (const background of [ok, bad]) for (const [key, values] of Object.entries(options)) for (const v of values) cases.push({ state, ...background, [key]: v })
  for (let mask = 0; mask < 32; mask++) {
    const pick = <K extends keyof typeof ok>(bit: number, k: K) => ((mask >> bit) & 1 ? ok[k] : bad[k])
    cases.push({ state, quote: pick(0, 'quote'), artwork: pick(1, 'artwork'), auth: pick(2, 'auth'), materials: pick(3, 'materials'), prep: pick(4, 'prep') })
  }
}

const REVISION = 5
const domainInput = (c: Case): ReadinessInput => ({
  state: c.state,
  quote: c.quote && { status: c.quote.status, itemsRevision: c.quote.match ? REVISION : REVISION - 1, lineCount: c.quote.products },
  itemsRevision: REVISION,
  artworkRequired: c.artwork.required,
  designs: c.artwork.designs.map((versions) => ({ currentVersion: { id: 0, fileId: 1, approval: versions.at(-1)! } })),
  poRequired: c.auth.poRequired,
  latestPo: c.auth.po && { status: c.auth.po },
  authorizedAt: c.auth.authorized ? '2026-10-01T00:00:00Z' : null,
  materialsRequired: c.materials.required,
  purchases: c.materials.purchases.map((p) => ({ storedStatus: p.status, quantity: p.quantity, receivedQuantity: p.receipts.reduce((a, b) => a + b, 0) })),
  prepStatus: c.prep,
})

test('SQL readiness, the DB loader and readiness() agree across the input space', async () => {
  const { db, sqlite } = createTestD1()
  const run = (sql: string, ...p: (string | number | null)[]) => sqlite.prepare(sql).run(...p)
  sqlite.exec(`INSERT INTO users (id, email, name, role) VALUES (1, 'o@x', 'O', 'owner');
    INSERT INTO customers (id, kind, name) VALUES (1, 'district', 'D');
    INSERT INTO files (id, r2_key, mime, bytes, sha256) VALUES (1, 'k', 'image/png', 1, 'x');`)
  const read = sqlite.prepare(`SELECT ${GATE_OK} AS ok, ${PRE_PRODUCTION} AS pre, ${ARTWORK_STATUS} AS art FROM orders WHERE id = ?`)
  let lineage = 0, checked = 0, refused = 0
  const addQuote = (orderId: number, version: number, revision: number, kinds: ('product' | 'charge')[], status: QuoteStatus) => {
    const q = Number(run('INSERT INTO quotes (order_id, version, items_revision, created_by) VALUES (?, ?, ?, 1)', orderId, version, revision).lastInsertRowid)
    kinds.forEach((kind, i) => kind === 'product'
      ? run("INSERT INTO quote_items (quote_id, position, kind, product, method, quantity, unit_price_cents, line_total_cents) VALUES (?, ?, 'product', 'Tee', 'screen', 1, 100, 100)", q, i)
      : run("INSERT INTO quote_items (quote_id, position, kind, description, quantity, unit_price_cents, line_total_cents) VALUES (?, ?, 'charge', 'Rush', 1, 100, 100)", q, i))
    if (status !== 'draft') run('UPDATE quotes SET status = ? WHERE id = ?', status, q)
  }

  for (const [n, c] of cases.entries()) {
    const number = `T-${n}`
    const orderId = Number(run(`INSERT INTO orders (number, customer_id, source, title, state, po_required, authorized_at, artwork_required, materials_required, prep_status, items_revision)
      VALUES (?, 1, 'phone', 't', ?, ?, ?, ?, ?, ?, ?)`, number, c.state, c.auth.poRequired ? 1 : 0, c.auth.authorized ? '2026-10-01T00:00:00Z' : null,
      c.artwork.required ? 1 : 0, c.materials.required ? 1 : 0, c.prep, REVISION).lastInsertRowid)
    if (c.quote) {
      // An older version that would satisfy readiness on its own, so "current = highest version" is what's tested.
      if (c.quote.prior) addQuote(orderId, 1, REVISION, ['product'], c.quote.status === 'accepted' ? 'superseded' : 'accepted')
      // A charge line on every quote, so a lineCount that counted it would show.
      const kinds: ('product' | 'charge')[] = c.quote.products ? ['product', 'charge'] : ['charge']
      try {
        addQuote(orderId, c.quote.prior ? 2 : 1, c.quote.match ? REVISION : REVISION - 1, kinds, c.quote.status)
      } catch (e) {
        // The database refuses to accept a quote without a product line (readiness's empty_quote can't be stored).
        expect(c.quote.status === 'accepted' && c.quote.products === 0, String(e)).toBe(true)
        expect(String(e)).toMatch(/no_product_line/)
        refused++
        continue
      }
    }
    for (const versions of c.artwork.designs) {
      lineage++
      versions.forEach((approval, i) => run(`INSERT INTO artwork (customer_id, order_id, lineage_id, version, file_id, approval_status, approved_at, approved_via, approval_recorded_by)
        VALUES (1, ?, ?, ?, 1, ?, ?, ?, ?)`, orderId, lineage, i + 1, approval, ...(approval === 'approved' ? ['2026-10-01T00:00:00Z', 'email', 1] : [null, null, null])))
    }
    if (c.auth.po) {
      // An older approved PO first, so "latest = highest id" is what's tested.
      run("INSERT INTO purchase_orders (order_id, po_number, status) VALUES (?, 'OLD', 'approved')", orderId)
      run("INSERT INTO purchase_orders (order_id, po_number, status) VALUES (?, 'NEW', ?)", orderId, c.auth.po)
    }

    for (const p of c.materials.purchases) {
      const id = Number(run("INSERT INTO order_purchases (order_id, supplier_id, description, quantity) VALUES (?, 1, 'Tees', ?)", orderId, p.quantity).lastInsertRowid)
      if (p.status === 'not_ordered') continue
      run("UPDATE order_purchases SET status = 'ordered', ordered_on = '2026-10-01' WHERE id = ?", id)
      for (const q of p.receipts) run("INSERT INTO purchase_receipts (purchase_id, quantity, received_on) VALUES (?, ?, '2026-10-02')", id, q)
      if (p.status === 'cancelled') run("UPDATE order_purchases SET status = 'cancelled' WHERE id = ?", id)
    }
    const input = domainInput(c)
    const expected = readiness(input)
    const row = read.get(orderId) as { ok: number; pre: string; art: string }
    const label = JSON.stringify(c)
    expect(Boolean(row.ok), label).toBe(expected.ready)
    expect(row.pre, label).toBe(expected.preProductionStatus)
    expect(row.art, label).toBe(orderArtworkStatus(input.artworkRequired, input.designs))
    const loaded = await readinessInput(db, (await getOrderByNumber(db, number))!)
    expect(loaded.quote, label).toEqual(input.quote)
    expect(loaded.purchases, label).toEqual(input.purchases)
    expect(readiness(loaded), label).toEqual(expected)
    checked++
  }
  expect(refused).toBeGreaterThan(0)
  expect(checked + refused).toBe(cases.length)
  expect(cases.length).toBeGreaterThan(600)
})
