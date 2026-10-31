import type { PoStatus } from '../../shared/enums.ts'

const transitions: Record<PoStatus, readonly PoStatus[]> = {
  requested: ['received'],
  received: ['under_review'],
  under_review: ['approved', 'rejected', 'correction_required'],
  // A corrected document must be received and reviewed again.
  correction_required: ['received'],
  rejected: ['requested'],
  // Approval may be revoked when the district cancels the PO.
  approved: ['rejected'],
}

export function checkPoTransition(from: PoStatus, to: PoStatus): { ok: true } | { ok: false; error: string } {
  if (from === to) return { ok: false, error: 'PO status is unchanged' }
  return transitions[from].includes(to)
    ? { ok: true }
    : { ok: false, error: `Invalid PO transition: ${from} to ${to}` }
}

/** The targets checkPoTransition would accept from `from`; the UI lists these in its status menu. */
export const allowedPoTransitions = (from: PoStatus): readonly PoStatus[] => transitions[from]
