import type { CustomerKind, PaymentTerms } from '../../shared/enums'

/** What a new customer's PO and payment defaults are when staff leave them blank. Districts and organizations buy on a PO and pay after pickup; individuals pay at pickup. */
export function customerDefaults(kind: CustomerKind): { defaultPoRequired: boolean; defaultPaymentTerms: PaymentTerms } {
  return kind === 'individual'
    ? { defaultPoRequired: false, defaultPaymentTerms: 'due_at_pickup' }
    : { defaultPoRequired: true, defaultPaymentTerms: 'due_after_pickup' }
}
