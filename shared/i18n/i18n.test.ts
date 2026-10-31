import { expect, it } from 'vitest'
import { PRODUCTION_STATUSES } from '../enums'
import { en } from './en'
import { es } from './es'

it('labels and plural forms resolve in both languages', () => {
  for (const s of PRODUCTION_STATUSES) expect(es.labels.productionStatus[s]).toBeTruthy()
  expect(en.time.overdueDays(1)).toBe('Overdue 1 day')
  expect(es.time.overdueDays(2)).toBe('Atrasado 2 días')
})

it('authorization and quote-decision sentences are whole per method/status, never a label spliced in', () => {
  expect(es.order.readiness.authDone.phone('1 jun')).toBe('Autorizado por teléfono el 1 jun')
  expect(es.order.readiness.authDone.email('1 jun')).toBe('Autorizado por correo electrónico el 1 jun')
  expect(es.order.readiness.authDone.in_person('1 jun')).toBe('Autorizado en persona el 1 jun')
  expect(es.order.readiness.authDone.signed_form('1 jun')).toBe('Autorizado con formulario firmado el 1 jun')
  expect(es.order.readiness.authDone.other('1 jun')).toBe('Autorizado (otro medio) el 1 jun')
  expect(es.order.quote.decided.accepted('1 jun')).toBe('aceptada el 1 jun')
  expect(es.order.quote.decided.declined('1 jun')).toBe('rechazada el 1 jun')
  expect(en.order.readiness.authDone.signed_form('Jun 1')).toBe('Authorized with a signed form on Jun 1')
})
