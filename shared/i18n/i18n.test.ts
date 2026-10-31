import { expect, it } from 'vitest'
import { CHECK_STATUSES, FINANCIAL_STATUSES, FULFILMENT_STATUSES, NOTIFICATION_METHODS, PAYMENT_METHODS, PAYMENT_NEXT_ACTIONS, PRODUCTION_STATUSES } from '../enums'
import { ACTIVITY_ACTIONS, API_ERROR_CODES } from '../api'
import { en } from './en'
import { es } from './es'

it('labels and plural forms resolve in both languages', () => {
  for (const s of PRODUCTION_STATUSES) expect(es.labels.productionStatus[s]).toBeTruthy()
  expect(en.time.overdueDays(1)).toBe('Overdue 1 day')
  expect(es.time.overdueDays(2)).toBe('Atrasado 2 días')
})

it('every M5 vocabulary value and error code has a label in both languages, and every error and activity sentence is translated', () => {
  const sets = [
    ['notificationMethod', NOTIFICATION_METHODS], ['paymentMethod', PAYMENT_METHODS], ['checkStatus', CHECK_STATUSES],
    ['fulfilmentStatus', FULFILMENT_STATUSES], ['financialStatus', FINANCIAL_STATUSES], ['paymentNextAction', PAYMENT_NEXT_ACTIONS],
  ] as const
  for (const [key, values] of sets) for (const v of values) {
    const pair = [(en.labels[key] as Record<string, string>)[v], (es.labels[key] as Record<string, string>)[v]]
    expect(pair.every(Boolean), `${key}.${v}`).toBe(true)
  }
  for (const code of API_ERROR_CODES) expect(es.api.errors[code] && es.api.errors[code] !== en.api.errors[code], code).toBeTruthy()
  for (const a of ACTIVITY_ACTIONS) expect(es.activity[a]('2026-0001'), a).not.toBe(en.activity[a]('2026-0001'))
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
