import { expect, it } from 'vitest'
import { PRODUCTION_STATUSES } from '../enums'
import { en } from './en'
import { es } from './es'

it('labels and plural forms resolve in both languages', () => {
  for (const s of PRODUCTION_STATUSES) expect(es.labels.productionStatus[s]).toBeTruthy()
  expect(en.time.overdueDays(1)).toBe('Overdue 1 day')
  expect(es.time.overdueDays(2)).toBe('Atrasado 2 días')
})
