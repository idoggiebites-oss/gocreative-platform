import { formatOrderNumber, parseOrderNumber } from './orderNumber.ts'

it.each([1, 9, 123, 9999, 12345, Number.MAX_SAFE_INTEGER])('round-trips counter %i', n => {
  expect(parseOrderNumber(formatOrderNumber(2026, n))).toEqual({ year: 2026, n })
})
it('pads short counters and preserves longer ones', () => {
  expect(formatOrderNumber(2026, 1)).toBe('2026-0001')
  expect(formatOrderNumber(2026, 12345)).toBe('2026-12345')
})
it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid counter %s', n => {
  expect(() => formatOrderNumber(2026, n)).toThrow(RangeError)
})
it.each([999, 10000, 2026.5, NaN, Infinity])('rejects invalid year %s', year => {
  expect(() => formatOrderNumber(year, 1)).toThrow(RangeError)
})
it.each(['', '2026-0000', '2026-1', '2026-00001', '026-0001', '02026-0001', '0000-0001', '2026-12345x', '2026-0001\n', ' 2026-0001', '2026-0001 ', '2026--001', '2026-1.00', '2026-+001', '2026-9007199254740992'])('rejects malformed number %j', s => {
  expect(parseOrderNumber(s)).toBeNull()
})
