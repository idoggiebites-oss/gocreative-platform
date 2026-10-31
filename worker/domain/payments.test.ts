import { balance, checkCheckTransition, daysOutstanding, matchRetry, nextPaymentAction, settledState, takesCheckCollection } from './payments.ts'
import { CHECK_STATUSES } from '../../shared/enums.ts'
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

it('a cancelled order stays cancelled; otherwise closed exactly when picked up and paid', () => {
  for (const state of ['active', 'closed', 'cancelled'] as const) for (const pickedUp of [true, false]) for (const f of ['unpaid', 'partially_paid', 'paid'] as const) {
    expect(settledState(state, pickedUp, f)).toBe(state === 'cancelled' ? 'cancelled' : pickedUp && f === 'paid' ? 'closed' : 'active')
  }
})
it('next payment action: a ready check first, then an awaited one, then by terms', () => {
  const base = { paymentTerms: 'due_after_pickup' as const, pickedUp: true, openChecks: [] }
  expect(nextPaymentAction({ ...base, openChecks: ['awaiting_payment', 'ready_for_collection'] })).toBe('collect_check')
  expect(nextPaymentAction({ ...base, openChecks: ['awaiting_payment'] })).toBe('await_check')
  expect(nextPaymentAction(base)).toBe('request_check')
  expect(nextPaymentAction({ ...base, paymentTerms: 'due_at_pickup', pickedUp: false })).toBe('collect_at_pickup')
  expect(nextPaymentAction({ ...base, paymentTerms: 'due_at_pickup' })).toBe('record_payment')
})
it('days outstanding count from pickup (after-pickup terms) or from ready (at-pickup terms)', () => {
  const i = { readyOn: '2026-10-01', pickedUpOn: '2026-10-20', today: '2026-10-31' }
  expect(daysOutstanding({ ...i, paymentTerms: 'due_after_pickup' })).toBe(11)
  expect(daysOutstanding({ ...i, paymentTerms: 'due_at_pickup' })).toBe(30)
  expect(daysOutstanding({ ...i, paymentTerms: 'due_after_pickup', pickedUpOn: null })).toBeNull()
  expect(daysOutstanding({ ...i, paymentTerms: 'due_at_pickup', readyOn: '2026-11-02' })).toBe(0)
  expect(takesCheckCollection('due_after_pickup')).toBe(true)
  expect(takesCheckCollection('due_at_pickup')).toBe(false)
})
