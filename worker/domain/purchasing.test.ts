import { checkReceipt, purchaseStatus } from './purchasing.ts'
it('derives partial and over-received purchases from receipts', () => {
  const purchase = { storedStatus: 'ordered' as const, quantity: 10 }
  for (const [receipts, status, receivedQuantity, overReceived] of [
    [[], 'ordered', 0, false], [[3, 2], 'partially_received', 5, false], [[3, 7], 'received', 10, false], [[11], 'received', 11, true],
  ] as const) expect(purchaseStatus(purchase, receipts.map(quantity => ({ quantity })))).toEqual({ ok: true, status, receivedQuantity, overReceived })
})
it('refuses new receipts on unordered/cancelled purchases but keeps historical ones', () => {
  for (const storedStatus of ['not_ordered', 'cancelled'] as const) {
    const purchase = { storedStatus, quantity: 10 }
    expect(purchaseStatus(purchase, [])).toMatchObject({ status: storedStatus, receivedQuantity: 0 })
    expect(checkReceipt(purchase, { quantity: 1 })).toEqual({ ok: false, error: 'purchase_not_ordered' })
  }
  // Cancelled after a partial delivery: the goods already received still count.
  expect(purchaseStatus({ storedStatus: 'cancelled', quantity: 10 }, [{ quantity: 4 }])).toEqual({ ok: true, status: 'cancelled', receivedQuantity: 4, overReceived: false })
  expect(purchaseStatus({ storedStatus: 'cancelled', quantity: 10 }, [{ quantity: 0 }]).ok).toBe(false)
})
it('rejects unsafe quantities and summed receipts', () => {
  const purchase = { storedStatus: 'ordered' as const, quantity: 10 }
  for (const quantity of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(purchaseStatus({ ...purchase, quantity }, []).ok).toBe(false)
    expect(checkReceipt(purchase, { quantity }).ok).toBe(false)
  }
  expect(purchaseStatus(purchase, [{ quantity: Number.MAX_SAFE_INTEGER }, { quantity: 1 }]).ok).toBe(false)
})
