import type { ArtworkApproval, OrderArtworkStatus, OrderState, PoStatus, PrepStatus, ProductionStatus, PurchaseStoredStatus, QuoteStatus } from '../../shared/enums.ts'
import { quoteSatisfied } from './quotes.ts'

// currentVersion is null when a design has no uploaded file yet; that counts as not received.
export type Design = { currentVersion: { id: number; fileId: number; approval: ArtworkApproval } | null }
export type ReadinessInput = {
  state: OrderState
  // lineCount: PRODUCT lines in the current quote's snapshot (charges and discounts don't count);
  // acceptance requires one (checkQuoteAcceptable, and the quotes_accept_needs_product trigger).
  quote: { status: QuoteStatus; itemsRevision: number; lineCount: number } | null
  itemsRevision: number
  artworkRequired: boolean
  designs: Design[]
  poRequired: boolean
  latestPo: { status: PoStatus } | null
  authorizedAt: string | null
  materialsRequired: boolean
  purchases: { storedStatus: PurchaseStoredStatus; quantity: number; receivedQuantity: number }[]
  prepStatus: PrepStatus
}
type Key = 'quote' | 'authorization' | 'artwork' | 'materials' | 'preparation'
export type Readiness = {
  items: { key: Key; state: 'complete' | 'pending' | 'not_required'; reason?: string }[]
  ready: boolean
  preProductionStatus: ProductionStatus
}
export function orderArtworkStatus(artworkRequired: boolean, designs: readonly Design[]): OrderArtworkStatus {
  if (!artworkRequired) return 'not_required'
  if (!designs.length || designs.some(d => !d.currentVersion)) return 'not_received'
  if (designs.some(d => d.currentVersion?.approval === 'changes_requested')) return 'changes_requested'
  if (designs.some(d => d.currentVersion?.approval === 'under_review')) return 'under_review'
  return 'approved'
}
export function readiness(input: ReadinessInput): Readiness {
  const items: Readiness['items'] = []
  const add = (key: Key, reason?: string, required = true) => {
    items.push({ key, state: !required ? 'not_required' : reason ? 'pending' : 'complete', ...(required && reason ? { reason } : {}) })
  }
  add('quote', !input.quote ? 'no_quote' : input.quote.status !== 'accepted' ? 'not_accepted'
    : !quoteSatisfied(input.quote, input.itemsRevision) ? 'items_changed_since_acceptance'
    : !(input.quote.lineCount > 0) ? 'empty_quote' : undefined)
  // Direct authorization cannot substitute for the required PO.
  add('authorization', input.poRequired ? !input.latestPo ? 'po_missing' : input.latestPo.status !== 'approved' ? 'po_not_approved' : undefined
    : input.authorizedAt ? undefined : 'not_authorized')
  const artwork = orderArtworkStatus(input.artworkRequired, input.designs)
  add('artwork', artwork === 'approved' || artwork === 'not_required' ? undefined : artwork, input.artworkRequired)
  const purchases = input.purchases.filter(p => p.storedStatus !== 'cancelled')
  add('materials', !purchases.length ? 'not_ordered' : purchases.every(p => Number.isSafeInteger(p.quantity) && p.quantity >= 1
    && Number.isSafeInteger(p.receivedQuantity) && p.receivedQuantity >= p.quantity) ? undefined : 'awaiting_delivery', input.materialsRequired)
  add('preparation', input.prepStatus === 'ready' ? undefined : input.prepStatus, input.prepStatus !== 'not_required')
  const pending = items.find(item => item.state === 'pending')
  return { items, ready: input.state === 'active' && !pending,
    preProductionStatus: pending ? `awaiting_${pending.key}` : 'ready' }
}
/** The production gate as reason codes (shared/api GATE_REASON_CODES): 'order_not_active', then '<item>.<reason>' per pending item. */
export function gateResult(state: OrderState, r: Readiness): { ok: true } | { ok: false; reasons: string[] } {
  const reasons = [...(state === 'active' ? [] : ['order_not_active']), ...r.items.flatMap(i => i.state === 'pending' ? [`${i.key}.${i.reason}`] : [])]
  return reasons.length ? { ok: false, reasons } : { ok: true }
}
