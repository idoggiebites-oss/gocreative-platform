import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { ARTWORK_STATUSES, ORDER_STATES, PO_STATUSES } from '../../shared/enums'
import { canEnterProduction, preProductionStatus, type GatePo } from '../../worker/domain/production'
import { GATE_OK, PRE_PRODUCTION } from '../../worker/db/orders'
import { createTestD1 } from './d1'

// The gate exists twice: in worker/domain (what the UI and routes check) and as SQL
// in worker/db/orders.ts (re-asserted inside the write, so a concurrent PO change
// can't slip past). This walks every combination and fails if the two ever disagree.
test('SQL gate and awaiting-status derivation match the domain rules', () => {
  const { sqlite } = createTestD1()
  sqlite.exec(readFileSync(new URL('../../scripts/seed.sql', import.meta.url), 'utf8'))
  const { id } = sqlite.prepare("SELECT id FROM orders WHERE number = '2026-0001'").get() as { id: number }
  const read = sqlite.prepare(`SELECT ${GATE_OK} AS ok, ${PRE_PRODUCTION} AS pre FROM orders WHERE id = ?`)
  let cases = 0
  for (const state of ORDER_STATES)
    for (const artworkStatus of ARTWORK_STATUSES)
      for (const poRequired of [false, true])
        for (const authorizedAt of [null, '2026-10-01T00:00:00Z'])
          for (const po of [null, ...PO_STATUSES] as const) {
            sqlite.prepare('DELETE FROM po_documents WHERE po_id IN (SELECT id FROM purchase_orders WHERE order_id = ?)').run(id)
            sqlite.prepare('DELETE FROM purchase_orders WHERE order_id = ?').run(id)
            // An older approved PO first, so "latest = highest id" is what's being tested.
            if (po) {
              sqlite.prepare("INSERT INTO purchase_orders (order_id, po_number, status) VALUES (?, 'OLD', 'approved')").run(id)
              sqlite.prepare("INSERT INTO purchase_orders (order_id, po_number, status) VALUES (?, 'NEW', ?)").run(id, po)
            }
            sqlite
              .prepare('UPDATE orders SET state = ?, artwork_status = ?, po_required = ?, authorized_at = ? WHERE id = ?')
              .run(state, artworkStatus, poRequired ? 1 : 0, authorizedAt, id)
            const order = { state, artworkStatus, poRequired, authorizedAt }
            const latestPo: GatePo = po ? { status: po } : null
            const row = read.get(id) as { ok: number; pre: string }
            const label = JSON.stringify({ ...order, po })
            expect(Boolean(row.ok), label).toBe(canEnterProduction(order, latestPo).ok)
            expect(row.pre, label).toBe(preProductionStatus(order, latestPo))
            cases++
          }
  expect(cases).toBe(ORDER_STATES.length * ARTWORK_STATUSES.length * 2 * 2 * (PO_STATUSES.length + 1))
})
