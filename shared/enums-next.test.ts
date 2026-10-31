/// <reference types="vitest/globals" />
import * as next from './enums-next.ts'
import { PRODUCTION_STATUSES } from './enums.ts'
it('keeps the transitional vocabulary separate from Phase 1', () => {
  expect(next.PRODUCTION_STATUSES_NEXT).toEqual(['awaiting_quote', 'awaiting_authorization', 'awaiting_artwork', 'awaiting_materials', 'awaiting_preparation', 'ready', 'in_production', 'quality_control', 'production_complete'])
  expect(PRODUCTION_STATUSES).toContain('completed')
  expect(next.ORDER_STATES_NEXT).toEqual(['active', 'cancelled', 'closed'])
  expect(next.QUOTE_STATUSES).toEqual(['draft', 'sent', 'accepted', 'declined', 'superseded'])
  for (const values of Object.values(next)) expect(new Set(values).size).toBe(values.length)
})
