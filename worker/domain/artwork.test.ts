import { expect, it } from 'vitest'
import { checkArtworkDecision } from './artwork'

it('only the current version, and only to a different status', () => {
  expect(checkArtworkDecision({ approval: 'under_review', isCurrent: false }, 'approved')).toEqual({ ok: false, error: 'not_current_version' })
  expect(checkArtworkDecision({ approval: 'approved', isCurrent: true }, 'approved')).toEqual({ ok: false, error: 'artwork_unchanged' })
  expect(checkArtworkDecision({ approval: 'under_review', isCurrent: true }, 'approved')).toEqual({ ok: true })
  expect(checkArtworkDecision({ approval: 'under_review', isCurrent: true }, 'changes_requested')).toEqual({ ok: true })
  expect(checkArtworkDecision({ approval: 'approved', isCurrent: true }, 'changes_requested')).toEqual({ ok: true })
  expect(checkArtworkDecision({ approval: 'changes_requested', isCurrent: true }, 'approved')).toEqual({ ok: true })
})
