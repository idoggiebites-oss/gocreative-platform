import { fulfilmentStatus, checkPickupRelease, isClosed } from './fulfilment.ts'
import { FINANCIAL_STATUSES, FULFILMENT_STATUSES, PRODUCTION_STATUSES_NEXT } from '../../shared/enums-next.ts'
it('keeps fulfilment separate from production and payment', () => {
  for (const status of PRODUCTION_STATUSES_NEXT) expect(fulfilmentStatus(status, { notifiedAt: 'now', pickedUpAt: 'now' })).toBe(status === 'production_complete' ? 'picked_up' : 'not_ready')
  expect(fulfilmentStatus('production_complete', null)).toBe('ready_for_pickup')
  expect(fulfilmentStatus('production_complete', { notifiedAt: 'now', pickedUpAt: null })).toBe('customer_notified')
  for (const fulfilment of FULFILMENT_STATUSES) for (const financial of FINANCIAL_STATUSES) expect(isClosed(fulfilment, financial)).toBe(fulfilment === 'picked_up' && financial === 'paid')
})
it('requires payment or a reasoned owner override only when due at pickup', () => {
  const input = { paymentTerms: 'due_at_pickup' as const, outstandingCents: 100, override: false, role: 'staff' as const }
  expect(checkPickupRelease(input)).toMatchObject({ error: 'payment_required' })
  expect(checkPickupRelease({ ...input, paymentTerms: 'due_after_pickup' })).toEqual({ ok: true, overrideUsed: false })
  for (const outstandingCents of [0, -1]) expect(checkPickupRelease({ ...input, outstandingCents, override: true })).toEqual({ ok: true, overrideUsed: false })
  expect(checkPickupRelease({ ...input, override: true, reason: 'rush' })).toMatchObject({ error: 'override_requires_owner' })
  expect(checkPickupRelease({ ...input, override: true, role: 'owner', reason: ' ' })).toMatchObject({ error: 'override_requires_reason' })
  expect(checkPickupRelease({ ...input, override: true, role: 'owner', reason: 'approved' })).toEqual({ ok: true, overrideUsed: true })
  expect(checkPickupRelease({ ...input, outstandingCents: NaN }).ok).toBe(false)
})
