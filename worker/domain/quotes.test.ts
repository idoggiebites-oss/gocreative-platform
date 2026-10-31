import { QUOTE_STATUSES } from '../../shared/enums.ts'
import { acceptBlockCode, quoteActionsOpen, checkQuoteAcceptable, checkQuoteTransition, currentQuote, itemsChangeRequiresReapproval, lineTotalCents, planNewVersion, quoteSatisfied, quoteTotals, restoreLines, sizesTotal, snapshot, validateItem, CUSTOMER_FACING_ITEM_FIELDS } from './quotes.ts'
import type { Item } from './quotes.ts'
const item: Item = { id: 1, kind: 'product', quantity: 2, unitPriceCents: 150, sizes: { M: 2 } }
it('totals product, charge and discount cents', () => {
  expect(lineTotalCents(item)).toEqual({ ok: true, totalCents: 300 })
  expect(quoteTotals([item, { kind: 'charge', quantity: 1, unitPriceCents: 50 }, { kind: 'discount', quantity: 2, unitPriceCents: 25 }])).toEqual({ ok: true, subtotalCents: 300, chargesCents: 50, discountsCents: 50, totalCents: 300 })
  expect(quoteTotals([])).toMatchObject({ totalCents: 0 })
  expect(quoteTotals([{ kind: 'discount', quantity: 1, unitPriceCents: 1 }])).toEqual({ ok: false, error: 'discount_exceeds_total' })
})
it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid quantities %s for every kind', quantity => {
  for (const kind of ['product', 'charge', 'discount'] as const) expect(lineTotalCents({ ...item, kind, quantity }).ok).toBe(false)
})
it('rejects unsafe money inputs, products and sums', () => {
  for (const unitPriceCents of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(lineTotalCents({ ...item, unitPriceCents }).ok).toBe(false)
  expect(lineTotalCents({ ...item, unitPriceCents: Number.MAX_SAFE_INTEGER }).ok).toBe(false)
  expect(quoteTotals([{ ...item, quantity: 1, unitPriceCents: Number.MAX_SAFE_INTEGER }, item]).ok).toBe(false)
  expect(lineTotalCents({ ...item, unitPriceCents: 0 })).toMatchObject({ totalCents: 0 })
})
it('validates sizes including zeros, absent sizes and overflow', () => {
  expect(sizesTotal(null)).toEqual({ ok: true, quantity: 0 })
  expect(validateItem({ ...item, sizes: { S: 0, M: 2 } })).toEqual({ ok: true })
  expect(validateItem({ ...item, sizes: null }).ok).toBe(true)
  expect(validateItem({ ...item, sizes: {} }).ok).toBe(false)
  for (const n of [-1, 0.5, NaN, Infinity]) expect(sizesTotal({ M: n }).ok).toBe(false)
  expect(sizesTotal({ M: Number.MAX_SAFE_INTEGER, L: 1 }).ok).toBe(false)
})
it.each(CUSTOMER_FACING_ITEM_FIELDS)('requires reapproval for %s', field => {
  const changed = { ...item, [field]: field === 'sizes' ? { L: 2 } : field === 'quantity' || field === 'unitPriceCents' ? 3 : 'changed' } as Item
  expect(itemsChangeRequiresReapproval([item], [changed])).toBe(true)
})
it('matches IDs, ignores internal edits and zero sizes, and detects new/removed lines', () => {
  expect(itemsChangeRequiresReapproval([item], [{ ...item, sizes: { L: 0, M: 2 }, notes: 'new', supplierId: 2, estimatedUnitCostCents: 9, actualUnitCostCents: 10, arbitrary: true }])).toBe(false)
  const second = { ...item, id: 2 }
  expect(itemsChangeRequiresReapproval([item, second], [second, item])).toBe(false)
  expect(itemsChangeRequiresReapproval([item], [])).toBe(true)
  expect(itemsChangeRequiresReapproval([], [item])).toBe(true)
  expect(itemsChangeRequiresReapproval([item], [{ ...item, id: undefined }])).toBe(true)
  expect(itemsChangeRequiresReapproval([item], [second])).toBe(true)
})
it('snapshots lines with signed totals and refuses a discount larger than the total', () => {
  const charge: Item = { kind: 'charge', quantity: 1, unitPriceCents: 500 }
  const discount: Item = { kind: 'discount', quantity: 1, unitPriceCents: 100 }
  expect(snapshot([item, charge, discount])).toEqual({ ok: true, totals: { subtotalCents: 300, chargesCents: 500, discountsCents: 100, totalCents: 700 },
    lines: [{ ...item, lineTotalCents: 300 }, { ...charge, lineTotalCents: 500 }, { ...discount, lineTotalCents: -100 }] })
  expect(snapshot([item, { ...discount, unitPriceCents: 1000 }])).toEqual({ ok: false, error: 'discount_exceeds_total' })
  expect(snapshot([{ ...item, sizes: { M: 1 } }])).toEqual({ ok: false, error: 'sizes_quantity_mismatch' })
})
it('restores quote lines onto the items position by position', () => {
  const restored = restoreLines([{ id: 7 }], [{ ...item, id: 99 }, { ...item, id: 100 }])
  expect(restored.map((l) => l.id)).toEqual([7, undefined])
  // Same content at the same position is not a change; an extra line is.
  expect(itemsChangeRequiresReapproval([{ ...item, id: 7 }], restoreLines([{ id: 7 }], [item]))).toBe(false)
  expect(itemsChangeRequiresReapproval([{ ...item, id: 7 }], restored)).toBe(true)
})
it('exhaustively checks quote transitions', () => {
  for (const from of QUOTE_STATUSES) for (const to of QUOTE_STATUSES) {
    const allowed = from === 'draft' && ['sent', 'accepted', 'declined'].includes(to) || from === 'sent' && ['accepted', 'declined'].includes(to)
    expect(checkQuoteTransition(from, to).ok).toBe(allowed)
  }
})
it('versions supersede only live quotes and current means highest version', () => {
  const versions = QUOTE_STATUSES.map((status, i) => ({ id: i, version: 5 - i, status }))
  expect(planNewVersion(versions)).toEqual({ version: 6, supersedeIds: [0, 1, 2] })
  expect(planNewVersion([])).toEqual({ version: 1, supersedeIds: [] })
  expect(currentQuote(versions)).toBe(versions[0])
  expect(currentQuote([])).toBeNull()
  expect(quoteSatisfied(null, 1)).toBe(false)
  for (const status of QUOTE_STATUSES) expect(quoteSatisfied({ status, itemsRevision: 2 }, 2)).toBe(status === 'accepted')
  expect(quoteSatisfied({ status: 'accepted', itemsRevision: 1 }, 2)).toBe(false)
})
it('accepts a quote only with a valid product line, even at zero dollars', () => {
  expect(checkQuoteAcceptable([])).toEqual({ ok: false, error: 'no_product_line' })
  expect(checkQuoteAcceptable([{ kind: 'charge', quantity: 1, unitPriceCents: 500 }])).toEqual({ ok: false, error: 'no_product_line' })
  expect(checkQuoteAcceptable([{ ...item, unitPriceCents: 0 }])).toEqual({ ok: true })
  expect(checkQuoteAcceptable([item, { kind: 'charge', quantity: 1, unitPriceCents: 50 }])).toEqual({ ok: true })
  expect(checkQuoteAcceptable([{ ...item, sizes: { M: 1 } }])).toEqual({ ok: false, error: 'sizes_quantity_mismatch' })
  expect(checkQuoteAcceptable([item, { kind: 'charge', quantity: 0, unitPriceCents: 50 }])).toEqual({ ok: false, error: 'invalid_quantity' })
  expect(checkQuoteAcceptable([item, { kind: 'discount', quantity: 1, unitPriceCents: 301 }])).toEqual({ ok: false, error: 'discount_exceeds_total' })
})

it('acceptBlockCode names why a quote cannot be accepted, null when it can', () => {
  expect(acceptBlockCode([])).toBe('no_product_line')
  expect(acceptBlockCode([{ kind: 'charge', quantity: 1, unitPriceCents: 50 }])).toBe('no_product_line')
  expect(acceptBlockCode([{ kind: 'product', quantity: 0, unitPriceCents: 50 }])).toBe('invalid')
  expect(acceptBlockCode([item])).toBeNull()
})
it('quote actions are closed once production has started or the order is not active', () => {
  expect(quoteActionsOpen({ state: 'active', productionStatus: 'awaiting_quote' })).toBe(true)
  expect(quoteActionsOpen({ state: 'active', productionStatus: 'ready' })).toBe(true)
  for (const productionStatus of ['in_production', 'quality_control', 'production_complete']) expect(quoteActionsOpen({ state: 'active', productionStatus }), productionStatus).toBe(false)
  expect(quoteActionsOpen({ state: 'cancelled', productionStatus: 'awaiting_quote' })).toBe(false)
})
