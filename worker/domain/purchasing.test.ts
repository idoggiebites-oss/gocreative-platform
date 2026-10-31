import { checkReceipt, purchaseStatus } from './purchasing.ts'
it('derives partial and over-received purchases from receipts', () => {
  const purchase = { storedStatus: 'ordered' as const, quantity: 10 }
  for (const [receipts, status, receivedQuantity, overReceived] of [
    [[], 'ordered', 0, false], [[3, 2], 'partially_received', 5, false], [[3, 7], 'received', 10, false], [[11], 'received', 11, true],
  ] as const) expect(purchaseStatus(purchase, receipts.map(quantity => ({ quantity })))).toEqual({ ok: true, status, receivedQuantity, overReceived })
})
it('rejects receipts on unordered/cancelled purchases', () => {
  for (const storedStatus of ['not_ordered', 'cancelled'] as const) {
    const purchase = { storedStatus, quantity: 10 }
    expect(purchaseStatus(purchase, [])).toMatchObject({ status: storedStatus, receivedQuantity: 0 })
    expect(checkReceipt(purchase, { quantity: 1 }).ok).toBe(false)
    expect(purchaseStatus(purchase, [{ quantity: 1 }]).ok).toBe(false)
  }
})
it('rejects unsafe quantities and summed receipts', () => {
  const purchase = { storedStatus: 'ordered' as const, quantity: 10 }
  for (const quantity of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(purchaseStatus({ ...purchase, quantity }, []).ok).toBe(false)
    expect(checkReceipt(purchase, { quantity }).ok).toBe(false)
  }
  expect(purchaseStatus(purchase, [{ quantity: Number.MAX_SAFE_INTEGER }, { quantity: 1 }]).ok).toBe(false)
})
