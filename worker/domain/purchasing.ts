import type { PurchaseStatus, PurchaseStoredStatus } from '../../shared/enums.ts'

type Purchase = { storedStatus: PurchaseStoredStatus; quantity: number }
type Failure = { ok: false; error: string }
function checkQuantities(purchase: Purchase, receipt: { quantity: number }): { ok: true } | Failure {
  if (!Number.isSafeInteger(purchase.quantity) || purchase.quantity < 1) return { ok: false, error: 'invalid_purchase_quantity' }
  if (!Number.isSafeInteger(receipt.quantity) || receipt.quantity < 1) return { ok: false, error: 'invalid_receipt_quantity' }
  return { ok: true }
}
// Permission to add a NEW receipt; history recorded before a cancellation stays valid (purchaseStatus).
export function checkReceipt(purchase: Purchase, receipt: { quantity: number }): { ok: true } | Failure {
  if (purchase.storedStatus !== 'ordered') return { ok: false, error: 'purchase_not_ordered' }
  return checkQuantities(purchase, receipt)
}
export function purchaseStatus(purchase: Purchase, receipts: readonly { quantity: number }[]): { ok: true; status: PurchaseStatus; receivedQuantity: number; overReceived: boolean } | Failure {
  if (!Number.isSafeInteger(purchase.quantity) || purchase.quantity < 1) return { ok: false, error: 'invalid_purchase_quantity' }
  let receivedQuantity = 0
  for (const receipt of receipts) {
    const result = checkQuantities(purchase, receipt)
    if (!result.ok) return result
    receivedQuantity += receipt.quantity
    if (!Number.isSafeInteger(receivedQuantity)) return { ok: false, error: 'quantity_overflow' }
  }
  const status = purchase.storedStatus !== 'ordered' ? purchase.storedStatus
    : receivedQuantity >= purchase.quantity ? 'received' : receivedQuantity > 0 ? 'partially_received' : 'ordered'
  return { ok: true, status, receivedQuantity, overReceived: receivedQuantity > purchase.quantity }
}

// Which fields staff may change, by stored status. Before ordering everything is a draft; once ordered only what is
// learned afterwards (the invoice's actual cost, a new arrival date, notes); a cancelled purchase is closed.
export const PURCHASE_FIELDS = ['supplierId', 'description', 'quantity', 'sizes', 'estimatedUnitCostCents', 'actualUnitCostCents', 'expectedOn', 'notes'] as const
export type PurchaseField = (typeof PURCHASE_FIELDS)[number]
const EDITABLE: Record<PurchaseStoredStatus, readonly PurchaseField[]> = {
  not_ordered: PURCHASE_FIELDS,
  ordered: ['actualUnitCostCents', 'expectedOn', 'notes'],
  cancelled: [],
}
export function checkPurchaseEdit(storedStatus: PurchaseStoredStatus, fields: readonly PurchaseField[]): { ok: true } | Failure {
  return fields.every(f => EDITABLE[storedStatus].includes(f)) ? { ok: true } : { ok: false, error: 'purchase_locked' }
}
// The app never buys anything: 'ordered' is staff confirming they bought it. Mirrors the order_purchases_status_move trigger.
export function checkPurchaseTransition(from: PurchaseStoredStatus, to: 'ordered' | 'cancelled'): { ok: true } | Failure {
  return from === 'not_ordered' || (from === 'ordered' && to === 'cancelled') ? { ok: true } : { ok: false, error: 'purchase_transition_not_allowed' }
}
/** quantity × unit cost, or null while the unit cost is unknown. */
export const purchaseTotal = (quantity: number, unitCents: number | null) => (unitCents === null ? null : quantity * unitCents)
