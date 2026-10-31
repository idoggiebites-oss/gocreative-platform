import type { FinancialStatus, FulfilmentStatus, PaymentTerms, ProductionStatus } from '../../shared/enums.ts'

export function fulfilmentStatus(productionStatus: ProductionStatus, pickup: { notifiedAt: string | null; pickedUpAt: string | null } | null): FulfilmentStatus {
  if (productionStatus !== 'production_complete') return 'not_ready'
  if (pickup?.pickedUpAt) return 'picked_up'
  if (pickup?.notifiedAt) return 'customer_notified'
  return 'ready_for_pickup'
}
export function checkPickupRelease(input: { paymentTerms: PaymentTerms; outstandingCents: number; override: boolean; role: 'owner' | 'staff'; reason?: string }): { ok: true; overrideUsed: boolean } | { ok: false; error: string } {
  if (!Number.isSafeInteger(input.outstandingCents)) return { ok: false, error: 'invalid_outstanding' }
  if (input.paymentTerms === 'due_after_pickup' || input.outstandingCents <= 0) return { ok: true, overrideUsed: false }
  if (!input.override) return { ok: false, error: 'payment_required' }
  if (input.role !== 'owner') return { ok: false, error: 'override_requires_owner' }
  if (!input.reason?.trim()) return { ok: false, error: 'override_requires_reason' }
  return { ok: true, overrideUsed: true }
}
export function isClosed(fulfilment: FulfilmentStatus, financial: FinancialStatus): boolean {
  return fulfilment === 'picked_up' && financial === 'paid'
}
