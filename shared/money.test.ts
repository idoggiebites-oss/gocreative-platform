/// <reference types="vitest/globals" />
import { formatCentsPlain, parseDollarsToCents } from './money.ts'
it.each([['12', 1200], ['12.5', 1250], ['12.50', 1250], [' $1,234.56 ', 123456], ['0', 0], ['90,071,992,547,409.91', Number.MAX_SAFE_INTEGER]])('parses %s exactly', (input, cents) => {
  expect(parseDollarsToCents(input)).toBe(cents)
})
it.each(['', ' ', '-1', '$-1', '1.234', '1.2x', '1,23.00', '12,34,567', '1e2', 'Infinity', '.50', '12.', '90071992547409.92'])('rejects %j', value => {
  expect(parseDollarsToCents(value)).toBeNull()
})
it.each([0, 1, 10, 123456, Number.MAX_SAFE_INTEGER])('round trips %i', cents => {
  expect(parseDollarsToCents(formatCentsPlain(cents))).toBe(cents)
})
it('formats form values and rejects invalid cents', () => {
  expect(formatCentsPlain(123456)).toBe('1234.56')
  for (const n of [-1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => formatCentsPlain(n)).toThrow(RangeError)
})
