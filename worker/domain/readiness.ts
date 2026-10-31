import type { PoStatus } from '../../shared/enums.ts'
import type { ArtworkApproval, OrderArtworkStatus, OrderStateNext, PrepStatus, ProductionStatusNext, PurchaseStoredStatus, QuoteStatus } from '../../shared/enums-next.ts'
import { quoteSatisfied } from './quotes.ts'

type Design = { latestApproval: ArtworkApproval }
export type ReadinessInput = {
  state: OrderStateNext
  quote: { status: QuoteStatus; itemsRevision: number } | null
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
  preProductionStatus: ProductionStatusNext
}
export function orderArtworkStatus(artworkRequired: boolean, designs: readonly Design[]): OrderArtworkStatus {
  if (!artworkRequired) return 'not_required'
  if (!designs.length) return 'not_received'
  if (designs.some(d => d.latestApproval === 'changes_requested')) return 'changes_requested'
  if (designs.some(d => d.latestApproval === 'under_review')) return 'under_review'
  return 'approved'
}
export function readiness(input: ReadinessInput): Readiness {
  const items: Readiness['items'] = []
  const add = (key: Key, reason?: string, required = true) => {
    items.push({ key, state: !required ? 'not_required' : reason ? 'pending' : 'complete', ...(required && reason ? { reason } : {}) })
  }
  add('quote', quoteSatisfied(input.quote, input.itemsRevision) ? undefined : !input.quote ? 'no_quote'
    : input.quote.status !== 'accepted' ? 'not_accepted' : 'items_changed_since_acceptance')
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
