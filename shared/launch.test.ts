import { expect, test } from 'vitest'
import { launchBlockers, sourceBlockers } from './launch'

const ready = { contact: { address: 'a', phone: 'p', email: 'e', hours: 'h' }, launch: { photosSupplied: true, privacyReviewed: true, servicesConfirmed: true } }

test('every missing fact blocks launch, and a complete business passes', () => {
  expect(launchBlockers(ready)).toEqual([])
  expect(launchBlockers({ ...ready, contact: { ...ready.contact, phone: null } as never })).toEqual(['Contact detail missing: phone'])
  expect(launchBlockers({ ...ready, launch: { ...ready.launch, privacyReviewed: false } })).toHaveLength(1)
})

test('today it is not ready, so nothing can pass the check by accident', () => {
  expect(launchBlockers().length).toBeGreaterThanOrEqual(7)
})

test('setting the flags cannot hide what is really there: blank or bracketed contacts and placeholder pages still block', () => {
  for (const phone of ['', '  ', '[Phone number]', 'TBD', 'placeholder']) expect(launchBlockers({ ...ready, contact: { ...ready.contact, phone } }), phone).toHaveLength(1)
  expect(sourceBlockers({ photo: '<span>Placeholder photo: x</span>', privacy: '[N weeks, to confirm]' })).toHaveLength(2)
  expect(sourceBlockers({ photo: '<img>', privacy: 'within 8 weeks' })).toEqual([])
})
