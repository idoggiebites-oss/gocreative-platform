import type { CustomerKind, PaymentTerms } from '../../shared/enums'

/** What a new customer's PO and payment defaults are when staff leave them blank. Districts and organizations buy on a PO and pay after pickup; individuals pay at pickup. */
export function customerDefaults(kind: CustomerKind): { defaultPoRequired: boolean; defaultPaymentTerms: PaymentTerms } {
  return kind === 'individual'
    ? { defaultPoRequired: false, defaultPaymentTerms: 'due_at_pickup' }
    : { defaultPoRequired: true, defaultPaymentTerms: 'due_after_pickup' }
}

/**
 * Pay-after-pickup lets an order leave unpaid without the owner's audited release override, so staff may use it only
 * where it is the customer kind's own default (districts and organizations); anywhere else it is owner-only
 * (Codex Phase 2 security review).
 */
export function payAfterPickupNeedsOwner(kind: CustomerKind, terms: PaymentTerms): boolean {
  return terms === 'due_after_pickup' && customerDefaults(kind).defaultPaymentTerms !== 'due_after_pickup'
}
