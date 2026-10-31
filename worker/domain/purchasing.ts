import type { PurchaseStatus, PurchaseStoredStatus } from '../../shared/enums-next.ts'

type Purchase = { storedStatus: PurchaseStoredStatus; quantity: number }
type Failure = { ok: false; error: string }
export function checkReceipt(purchase: Purchase, receipt: { quantity: number }): { ok: true } | Failure {
  if (purchase.storedStatus !== 'ordered') return { ok: false, error: 'purchase_not_ordered' }
  if (!Number.isSafeInteger(purchase.quantity) || purchase.quantity < 1) return { ok: false, error: 'invalid_purchase_quantity' }
  if (!Number.isSafeInteger(receipt.quantity) || receipt.quantity < 1) return { ok: false, error: 'invalid_receipt_quantity' }
  return { ok: true }
}
export function purchaseStatus(purchase: Purchase, receipts: readonly { quantity: number }[]): { ok: true; status: PurchaseStatus; receivedQuantity: number; overReceived: boolean } | Failure {
  if (!Number.isSafeInteger(purchase.quantity) || purchase.quantity < 1) return { ok: false, error: 'invalid_purchase_quantity' }
  let receivedQuantity = 0
  for (const receipt of receipts) {
    const result = checkReceipt(purchase, receipt)
    if (!result.ok) return result
    receivedQuantity += receipt.quantity
    if (!Number.isSafeInteger(receivedQuantity)) return { ok: false, error: 'quantity_overflow' }
  }
  const status = purchase.storedStatus !== 'ordered' ? purchase.storedStatus
    : receivedQuantity >= purchase.quantity ? 'received' : receivedQuantity > 0 ? 'partially_received' : 'ordered'
  return { ok: true, status, receivedQuantity, overReceived: receivedQuantity > purchase.quantity }
}
