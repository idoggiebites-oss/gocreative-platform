import type { CheckStatus, FinancialStatus, OrderState, PaymentMethod, PaymentNextAction, PaymentTerms } from '../../shared/enums.ts'
import { daysBetween } from '../../shared/businessDate.ts'

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

// ---- M5 ----

/** Check collection is the district workflow: only orders paid after pickup take one (DECISIONS 2026-10-31). */
export const takesCheckCollection = (paymentTerms: PaymentTerms) => paymentTerms === 'due_after_pickup'

/** What closing means for an order's state (PHASE2_PLAN §4.2): closed = picked up AND paid; a cancelled order stays cancelled. */
export function settledState(state: OrderState, pickedUp: boolean, financial: FinancialStatus): OrderState {
  if (state === 'cancelled') return state
  return pickedUp && financial === 'paid' ? 'closed' : 'active'
}

/**
 * The Payments page's next action for an order that still owes money: a check ready to collect comes first, then one the
 * district hasn't issued yet; otherwise pay-at-pickup orders are collected at the counter (or, once released, recorded),
 * and pay-after-pickup orders need a check requested.
 */
export function nextPaymentAction(i: { paymentTerms: PaymentTerms; pickedUp: boolean; openChecks: readonly CheckStatus[] }): PaymentNextAction {
  if (i.openChecks.includes('ready_for_collection')) return 'collect_check'
  if (i.openChecks.includes('awaiting_payment')) return 'await_check'
  if (i.paymentTerms === 'due_at_pickup') return i.pickedUp ? 'record_payment' : 'collect_at_pickup'
  return 'request_check'
}

/**
 * Days a balance has been owed, in shop days: from the pickup for pay-after-pickup orders (null until picked up), from the
 * day production completed for pay-at-pickup ones (null if unknown). Never negative.
 */
export function daysOutstanding(i: { paymentTerms: PaymentTerms; readyOn: string | null; pickedUpOn: string | null; today: string }): number | null {
  const from = i.paymentTerms === 'due_after_pickup' ? i.pickedUpOn : i.readyOn
  return from === null ? null : Math.max(0, daysBetween(from, i.today))
}
