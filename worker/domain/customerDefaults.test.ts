import { expect, test } from 'vitest'
import { customerDefaults } from './customerDefaults'

test('defaults by kind', () => {
  for (const k of ['district', 'organization'] as const) expect(customerDefaults(k)).toEqual({ defaultPoRequired: true, defaultPaymentTerms: 'due_after_pickup' })
  expect(customerDefaults('individual')).toEqual({ defaultPoRequired: false, defaultPaymentTerms: 'due_at_pickup' })
})
