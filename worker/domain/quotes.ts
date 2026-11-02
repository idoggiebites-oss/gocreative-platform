import type { ItemKind, QuoteStatus } from '../../shared/enums.ts'

type Failure = { ok: false; error: string }
export type Line = { kind: ItemKind; quantity: number; unitPriceCents: number }
export type Item = Line & {
  id?: string | number
  description?: string | null
  product?: string | null
  garmentColor?: string | null
  method?: string | null
  sizes?: Record<string, number> | null
  [key: string]: unknown
}

export function lineTotalCents(line: Line): { ok: true; totalCents: number } | Failure {
  if (!['product', 'charge', 'discount'].includes(line.kind)) return { ok: false, error: 'invalid_kind' }
  if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) return { ok: false, error: 'invalid_quantity' }
  if (!Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents < 0) return { ok: false, error: 'invalid_unit_price' }
  const total = line.quantity * line.unitPriceCents
  if (!Number.isSafeInteger(total)) return { ok: false, error: 'money_overflow' }
  return { ok: true, totalCents: line.kind === 'discount' && total !== 0 ? -total : total }
}

export function quoteTotals(lines: readonly Line[]) {
  let subtotalCents = 0, chargesCents = 0, discountsCents = 0
  for (const line of lines) {
    const result = lineTotalCents(line)
    if (!result.ok) return result
    if (line.kind === 'product') subtotalCents += result.totalCents
    else if (line.kind === 'charge') chargesCents += result.totalCents
    else discountsCents -= result.totalCents
    if (![subtotalCents, chargesCents, discountsCents, subtotalCents + chargesCents].every(Number.isSafeInteger)) return { ok: false as const, error: 'money_overflow' }
  }
  const totalCents = subtotalCents + chargesCents - discountsCents
  if (totalCents < 0) return { ok: false as const, error: 'discount_exceeds_total' }
  return { ok: true as const, subtotalCents, chargesCents, discountsCents, totalCents }
}

export function sizesTotal(sizes: Record<string, number> | null): { ok: true; quantity: number } | Failure {
  let quantity = 0
  for (const value of Object.values(sizes ?? {})) {
    if (!Number.isSafeInteger(value) || value < 0) return { ok: false, error: 'invalid_size_quantity' }
    quantity += value
    if (!Number.isSafeInteger(quantity)) return { ok: false, error: 'quantity_overflow' }
  }
  return { ok: true, quantity }
}

export function validateItem(item: Item): { ok: true } | Failure {
  const line = lineTotalCents(item)
  if (!line.ok) return line
  if (item.sizes != null) {
    const sizes = sizesTotal(item.sizes)
    if (!sizes.ok) return sizes
    if (sizes.quantity !== item.quantity) return { ok: false, error: 'sizes_quantity_mismatch' }
  }
  return { ok: true }
}

// Gate for draft/sent -> accepted: a customer can't approve an empty or invalid quote. $0 with a real line is fine.
export function checkQuoteAcceptable(lines: readonly Item[]): { ok: true } | Failure {
  if (!lines.some(line => line.kind === 'product')) return { ok: false, error: 'no_product_line' }
  for (const line of lines) {
    const result = validateItem(line)
    if (!result.ok) return result
  }
  const totals = quoteTotals(lines)
  return totals.ok ? { ok: true } : totals
}

/** Why a quote cannot be accepted yet, as a code the UI translates: no_product_line, or invalid for any other line problem. */
export function acceptBlockCode(lines: readonly Item[]): 'no_product_line' | 'invalid' | null {
  const r = checkQuoteAcceptable(lines)
  return r.ok ? null : r.error === 'no_product_line' ? 'no_product_line' : 'invalid'
}

/** Quote actions (create, duplicate, new version, refresh and the checklist's quote buttons) exist only while the order is active and production has not started. */
export function quoteActionsOpen(order: { state: string; productionStatus: string }): boolean {
  return order.state === 'active' && !['in_production', 'quality_control', 'production_complete'].includes(order.productionStatus)
}

export const CUSTOMER_FACING_ITEM_FIELDS = ['kind', 'description', 'product', 'garmentColor', 'method', 'sizes', 'quantity', 'unitPriceCents'] as const
function normalizedSizes(sizes: Item['sizes']): string {
  return JSON.stringify(Object.entries(sizes ?? {}).filter(([, n]) => n !== 0).sort(([a], [b]) => a.localeCompare(b)))
}
// What is made, as opposed to what it costs: a price agreed later must not undo a check of the specifications.
const SPECIFICATION_FIELDS = ['kind', 'description', 'product', 'garmentColor', 'method', 'sizes', 'quantity'] as const
export function specificationChanged(previous: Item | undefined, item: Item) {
  return !previous || SPECIFICATION_FIELDS.some((field) => (field === 'sizes' ? normalizedSizes(previous.sizes) !== normalizedSizes(item.sizes) : previous[field] !== item[field]))
}

export function itemsChangeRequiresReapproval(before: readonly Item[], after: readonly Item[]): boolean {
  if (before.length !== after.length) return true
  const byId = new Map(before.map(item => [item.id, item]))
  const seen = new Set<string | number>()
  return after.some(item => {
    // An unsaved line is an addition, even if its text matches an old line.
    if (item.id === undefined || seen.has(item.id)) return true
    seen.add(item.id)
    const previous = byId.get(item.id)
    return !previous || CUSTOMER_FACING_ITEM_FIELDS.some(field => field === 'sizes'
      ? normalizedSizes(previous.sizes) !== normalizedSizes(item.sizes)
      : previous[field] !== item[field])
  })
}

export function checkQuoteTransition(from: QuoteStatus, to: QuoteStatus): { ok: true } | Failure {
  return (from === 'draft' && ['sent', 'accepted', 'declined'].includes(to)) || (from === 'sent' && ['accepted', 'declined'].includes(to))
    ? { ok: true } : { ok: false, error: 'invalid_quote_transition' }
}
export function planNewVersion<T extends { id: string | number; version: number; status: QuoteStatus }>(versions: readonly T[]) {
  return { version: versions.reduce((max, v) => Math.max(max, v.version), 0) + 1,
    supersedeIds: versions.filter(v => ['draft', 'sent', 'accepted'].includes(v.status)).map(v => v.id) }
}
export function currentQuote<T extends { version: number }>(versions: readonly T[]): T | null {
  return versions.reduce<T | null>((current, v) => !current || v.version > current.version ? v : current, null)
}
export function quoteSatisfied(current: { status: QuoteStatus; itemsRevision: number } | null, orderItemsRevision: number): boolean {
  return current?.status === 'accepted' && current.itemsRevision === orderItemsRevision
}

/** A quote snapshot of `items`: each line with its signed total, and the quote totals (discount_exceeds_total if negative). */
export function snapshot<T extends Item>(items: readonly T[]) {
  const lines: (T & { lineTotalCents: number })[] = []
  for (const item of items) {
    const valid = validateItem(item)
    if (!valid.ok) return valid
    const line = lineTotalCents(item)
    if (!line.ok) return line
    lines.push({ ...item, lineTotalCents: line.totalCents })
  }
  const totals = quoteTotals(items)
  if (!totals.ok) return totals
  const { ok, ...rest } = totals
  return { ok, totals: rest, lines }
}
/** Lines copied back from a quote replace the items position by position, so the reapproval rule compares them in place. */
export function restoreLines<T extends Item>(current: readonly { id?: string | number }[], lines: readonly T[]): T[] {
  return lines.map((line, i) => ({ ...line, id: current[i]?.id }))
}
