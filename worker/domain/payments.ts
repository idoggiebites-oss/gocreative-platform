import type { CheckStatus, FinancialStatus } from '../../shared/enums-next.ts'

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
