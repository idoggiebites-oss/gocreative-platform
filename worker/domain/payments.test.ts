import { balance, checkCheckTransition, matchRetry } from './payments.ts'
import { CHECK_STATUSES } from '../../shared/enums-next.ts'
it.each([
  [null, [], null, 0, 'unpaid'], [null, [100], null, 0, 'partially_paid'],
  [200, [], 200, 0, 'unpaid'], [200, [50, 25], 125, 0, 'partially_paid'],
  [200, [100, 100], 0, 0, 'paid'], [200, [250], 0, 50, 'paid'], [0, [], 0, 0, 'paid'],
] as const)('derives balances for %s and %j', (agreed, amounts, outstandingCents, creditCents, status) => {
  expect(balance(agreed, amounts.map(amountCents => ({ amountCents })))).toEqual({ ok: true, receivedCents: amounts.reduce<number>((a, b) => a + b, 0), outstandingCents, creditCents, status })
})
it('rejects invalid and overflowing cents', () => {
  for (const n of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(balance(n, []).ok).toBe(false)
    expect(balance(100, [{ amountCents: n }]).ok).toBe(false)
  }
  expect(balance(100, [{ amountCents: 0 }]).ok).toBe(false)
  expect(balance(100, [{ amountCents: Number.MAX_SAFE_INTEGER }, { amountCents: 1 }]).ok).toBe(false)
})
it('only valid moves into collected create a payment, including retry rejection', () => {
  const allowed = ['awaiting_payment:ready_for_collection', 'awaiting_payment:collected', 'ready_for_collection:collected', 'collected:deposited', 'deposited:cleared']
  for (const from of CHECK_STATUSES) for (const to of CHECK_STATUSES) {
    const result = checkCheckTransition(from, to)
    expect(result.ok).toBe(allowed.includes(`${from}:${to}`))
    if (result.ok) expect(result.createsPayment).toBe(to === 'collected')
  }
})
it('treats an identical request_id resubmission as a retry and any difference as a conflict', () => {
  const existing = { id: 7, orderId: 1, amountCents: 500, method: 'cash' as const, paidOn: '2026-10-30', notes: null }
  const incoming = { orderId: 1, amountCents: 500, method: 'cash' as const, paidOn: '2026-10-30', notes: '' }
  expect(matchRetry(existing, incoming)).toEqual({ ok: true, payment: existing })
  expect(matchRetry(existing, { ...incoming, notes: '  ' })).toEqual({ ok: true, payment: existing })
  for (const patch of [{ orderId: 2 }, { amountCents: 501 }, { method: 'check' as const }, { paidOn: '2026-10-31' }, { notes: 'different' }]) {
    expect(matchRetry(existing, { ...incoming, ...patch })).toEqual({ ok: false, error: 'request_id_conflict' })
  }
})
