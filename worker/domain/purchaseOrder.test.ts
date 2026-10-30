import { PO_STATUSES } from '../../shared/enums.ts'
import { checkPoTransition } from './purchaseOrder.ts'

it('allows exactly the specified PO transitions, including revocation and resubmission', () => {
  const allowed = new Set([
    'requested:received', 'received:under_review', 'under_review:approved',
    'under_review:rejected', 'under_review:correction_required',
    'correction_required:received', 'rejected:requested', 'approved:rejected',
  ])
  for (const from of PO_STATUSES) for (const to of PO_STATUSES) {
    const result = checkPoTransition(from, to)
    expect(result.ok, `${from} → ${to}`).toBe(allowed.has(`${from}:${to}`))
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  }
})
