import { checkPurchaseEdit, checkPurchaseTransition, checkReceipt, PURCHASE_FIELDS, purchaseStatus, purchaseTotal } from './purchasing.ts'
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
it('edits: everything before ordering, only actual cost / expected date / notes once ordered, nothing once cancelled', () => {
  expect(checkPurchaseEdit('not_ordered', PURCHASE_FIELDS)).toEqual({ ok: true })
  expect(checkPurchaseEdit('ordered', ['actualUnitCostCents', 'expectedOn', 'notes'])).toEqual({ ok: true })
  for (const f of ['supplierId', 'description', 'quantity', 'sizes', 'estimatedUnitCostCents'] as const) {
    expect(checkPurchaseEdit('ordered', [f])).toEqual({ ok: false, error: 'purchase_locked' })
  }
  for (const f of PURCHASE_FIELDS) expect(checkPurchaseEdit('cancelled', [f]).ok).toBe(false)
})
it('transitions: not_ordered -> ordered / cancelled, ordered -> cancelled, nothing else', () => {
  expect(checkPurchaseTransition('not_ordered', 'ordered').ok).toBe(true)
  expect(checkPurchaseTransition('not_ordered', 'cancelled').ok).toBe(true)
  expect(checkPurchaseTransition('ordered', 'cancelled').ok).toBe(true)
  expect(checkPurchaseTransition('ordered', 'ordered').ok).toBe(false)
  expect(checkPurchaseTransition('cancelled', 'ordered').ok).toBe(false)
  expect(checkPurchaseTransition('cancelled', 'cancelled').ok).toBe(false)
  expect([purchaseTotal(12, 350), purchaseTotal(12, null)]).toEqual([4200, null])
})
