import { orderArtworkStatus, readiness } from './readiness.ts'
import type { ReadinessInput } from './readiness.ts'
const ready: ReadinessInput = { state: 'active', quote: { status: 'accepted', itemsRevision: 1 }, itemsRevision: 1, artworkRequired: true, designs: [{ latestApproval: 'approved' }], poRequired: false, latestPo: null, authorizedAt: '2026-01-01T00:00:00Z', materialsRequired: true, purchases: [{ storedStatus: 'ordered', quantity: 5, receivedQuantity: 5 }], prepStatus: 'ready' }
it('requires all five items, in fixed priority order', () => {
  expect(readiness(ready)).toMatchObject({ ready: true, preProductionStatus: 'ready' })
  expect(readiness(ready).items.map(i => i.key)).toEqual(['quote', 'authorization', 'artwork', 'materials', 'preparation'])
  const input: ReadinessInput = { ...ready, quote: null, authorizedAt: null, designs: [], purchases: [], prepStatus: 'not_started' }
  for (const [key, fix] of [
    ['quote', { quote: ready.quote }], ['authorization', { authorizedAt: ready.authorizedAt }], ['artwork', { designs: ready.designs }], ['materials', { purchases: ready.purchases }], ['preparation', { prepStatus: ready.prepStatus }],
  ] as const) {
    expect(readiness(input)).toMatchObject({ ready: false, preProductionStatus: `awaiting_${key}` })
    Object.assign(input, fix)
  }
  expect(readiness(input).ready).toBe(true)
})
it.each([
  [{ quote: null }, 'quote', 'no_quote'],
  [{ quote: { status: 'sent', itemsRevision: 1 } }, 'quote', 'not_accepted'],
  [{ itemsRevision: 2 }, 'quote', 'items_changed_since_acceptance'],
  [{ poRequired: true }, 'authorization', 'po_missing'],
  [{ poRequired: true, latestPo: { status: 'rejected' } }, 'authorization', 'po_not_approved'],
  [{ authorizedAt: null }, 'authorization', 'not_authorized'],
  [{ designs: [] }, 'artwork', 'not_received'],
  [{ designs: [{ latestApproval: 'approved' }, { latestApproval: 'under_review' }] }, 'artwork', 'under_review'],
  [{ purchases: [] }, 'materials', 'not_ordered'],
  [{ purchases: [{ storedStatus: 'cancelled', quantity: 5, receivedQuantity: 5 }] }, 'materials', 'not_ordered'],
  [{ purchases: [{ storedStatus: 'ordered', quantity: 5, receivedQuantity: 4 }] }, 'materials', 'awaiting_delivery'],
] as const)('explains pending prerequisites %j', (patch, key, reason) => {
  const result = readiness({ ...ready, ...patch } as ReadinessInput)
  expect(result.items.find(i => i.key === key)).toEqual({ key, state: 'pending', reason })
  expect(result.ready).toBe(false)
})
it('keeps PO/direct paths exclusive and ignores cancelled purchases', () => {
  expect(readiness({ ...ready, poRequired: true, authorizedAt: null, latestPo: { status: 'approved' } }).ready).toBe(true)
  expect(readiness({ ...ready, authorizedAt: null, latestPo: { status: 'approved' } }).ready).toBe(false)
  expect(readiness({ ...ready, purchases: [...ready.purchases, { storedStatus: 'cancelled', quantity: 5, receivedQuantity: 0 }] }).ready).toBe(true)
  expect(readiness({ ...ready, purchases: [...ready.purchases, { storedStatus: 'ordered', quantity: 1, receivedQuantity: 0 }] }).ready).toBe(false)
})
it('supports explicit exemptions and never readies inactive orders', () => {
  const result = readiness({ ...ready, artworkRequired: false, designs: [], materialsRequired: false, purchases: [], prepStatus: 'not_required' })
  expect(result.ready).toBe(true)
  expect(result.items.slice(2).map(i => i.state)).toEqual(['not_required', 'not_required', 'not_required'])
  for (const state of ['cancelled', 'closed'] as const) expect(readiness({ ...ready, state }).ready).toBe(false)
})
it('derives the worst current artwork approval', () => {
  expect(orderArtworkStatus(false, [])).toBe('not_required')
  expect(orderArtworkStatus(true, [])).toBe('not_received')
  expect(orderArtworkStatus(true, [{ latestApproval: 'approved' }])).toBe('approved')
  expect(orderArtworkStatus(true, [{ latestApproval: 'approved' }, { latestApproval: 'under_review' }])).toBe('under_review')
  const designs = [{ latestApproval: 'under_review' }, { latestApproval: 'changes_requested' }, { latestApproval: 'approved' }] as const
  expect(orderArtworkStatus(true, designs)).toBe('changes_requested')
  expect(orderArtworkStatus(true, [...designs].reverse())).toBe('changes_requested')
})
