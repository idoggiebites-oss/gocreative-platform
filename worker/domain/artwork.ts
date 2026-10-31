import type { ArtworkApproval } from '../../shared/enums.ts'

export type ArtworkDecision = 'approved' | 'changes_requested'

/**
 * Only the current (highest) version of a design may be decided, and only to a different status. A decision can
 * be reversed (the customer withdraws an approval, or approves after asking for changes); the history is in the
 * activity log. A new upload, not a decision, is what puts a design back under review.
 */
export function checkArtworkDecision(v: { approval: ArtworkApproval; isCurrent: boolean }, to: ArtworkDecision):
  { ok: true } | { ok: false; error: 'not_current_version' | 'artwork_unchanged' } {
  if (!v.isCurrent) return { ok: false, error: 'not_current_version' }
  if (v.approval === to) return { ok: false, error: 'artwork_unchanged' }
  return { ok: true }
}
