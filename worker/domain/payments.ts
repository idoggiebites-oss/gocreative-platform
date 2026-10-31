import type { CheckStatus, FinancialStatus, PaymentMethod } from '../../shared/enums-next.ts'

type Failure = { ok: false; error: string }
export function balance(agreedTotalCents: number | null, payments: readonly { amountCents: number }[]): {
  ok: true; receivedCents: number; outstandingCents: number | null; creditCents: number; status: FinancialStatus
} | Failure {
  if (agreedTotalCents !== null && (!Number.isSafeInteger(agreedTotalCents) || agreedTotalCents < 0)) return { ok: false, error: 'invalid_agreed_total' }
  let receivedCents = 0
  for (const payment of payments) {
    if (!Number.isSafeInteger(payment.amountCents) || payment.amountCents <= 0) return { ok: false, error: 'invalid_payment_amount' }
    receivedCents += payment.amountCents
    if (!Number.isSafeInteger(receivedCents)) return { ok: false, error: 'money_overflow' }
  }
  // Unknown agreed totals cannot imply either a paid order or a customer credit.
  if (agreedTotalCents === null) return { ok: true, receivedCents, outstandingCents: null, creditCents: 0, status: receivedCents ? 'partially_paid' : 'unpaid' }
  return { ok: true, receivedCents, outstandingCents: Math.max(0, agreedTotalCents - receivedCents), creditCents: Math.max(0, receivedCents - agreedTotalCents),
    status: receivedCents >= agreedTotalCents ? 'paid' : receivedCents > 0 ? 'partially_paid' : 'unpaid' }
}
export function checkCheckTransition(from: CheckStatus, to: CheckStatus): { ok: true; createsPayment: boolean } | Failure {
  const allowed: Record<CheckStatus, readonly CheckStatus[]> = {
    awaiting_payment: ['ready_for_collection', 'collected'], ready_for_collection: ['collected'], collected: ['deposited'], deposited: ['cleared'], cleared: [],
  }
  // Only collection creates a payment; deposit and clearance cannot insert it again.
  return allowed[from].includes(to) ? { ok: true, createsPayment: to === 'collected' } : { ok: false, error: 'invalid_check_transition' }
}

// A manual payment whose request_id already exists: an identical resubmission is a retry (the route
// returns the stored payment, 200); any other payload under the same request_id is a 409.
type PaymentFields = { orderId: number; amountCents: number; method: PaymentMethod; paidOn: string; notes: string | null }
export function matchRetry<T extends PaymentFields>(existing: T, incoming: PaymentFields): { ok: true; payment: T } | Failure {
  const notes = (n: string | null) => n?.trim() || null
  return existing.orderId === incoming.orderId && existing.amountCents === incoming.amountCents && existing.method === incoming.method
    && existing.paidOn === incoming.paidOn && notes(existing.notes) === notes(incoming.notes)
    ? { ok: true, payment: existing } : { ok: false, error: 'request_id_conflict' }
}
