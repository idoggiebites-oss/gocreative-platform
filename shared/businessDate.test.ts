/// <reference types="vitest/globals" />
import { addDays, businessToday, daysBetween } from './businessDate.ts'
it.each([
  ['2026-11-01T04:30:00Z', '2026-10-31'],
  ['2026-11-01T06:59:00Z', '2026-11-01'], ['2026-11-01T07:00:00Z', '2026-11-01'],
  ['2026-03-08T07:59:00Z', '2026-03-08'], ['2026-03-08T08:00:00Z', '2026-03-08'],
])('uses shop date at %s', (instant, date) => expect(businessToday(new Date(instant))).toBe(date))
it('allows another deployment time zone', () => expect(businessToday(new Date('2026-11-01T04:30Z'), 'UTC')).toBe('2026-11-01'))
it.each([['2026-01-31', 1, '2026-02-01'], ['2026-12-31', 1, '2027-01-01'], ['2026-01-01', -1, '2025-12-31'], ['2024-02-28', 1, '2024-02-29'], ['2026-02-28', 1, '2026-03-01']])('adds calendar days', (date, n, expected) => expect(addDays(date, n)).toBe(expected))
it.each([['2026-03-07', '2026-03-09'], ['2026-10-31', '2026-11-02']])('counts days across DST', (from, to) => {
  expect(daysBetween(from, to)).toBe(2)
  expect(daysBetween(to, from)).toBe(-2)
})
it('rejects malformed and overflowing calendar arithmetic', () => {
  for (const date of ['2026-02-30', '2026-1-01', 'garbage']) expect(() => addDays(date, 1)).toThrow(RangeError)
  expect(() => addDays('2026-01-01', 0.5)).toThrow(RangeError)
  expect(() => addDays('9999-12-31', 1)).toThrow(RangeError)
  expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0)
})
