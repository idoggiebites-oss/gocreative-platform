export function formatOrderNumber(year: number, n: number): string {
  // Canonical numbers must round-trip without losing counter precision.
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('Order counter must be a positive safe integer')
  if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new RangeError('Order year must have four digits')
  return `${year}-${String(n).padStart(4, '0')}`
}

export function parseOrderNumber(s: string): { year: number; n: number } | null {
  const match = /^([1-9]\d{3})-(\d{4,})$/.exec(s)
  if (!match) return null
  const year = Number(match[1])
  const n = Number(match[2])
  if (!Number.isSafeInteger(n) || n < 1) return null
  return formatOrderNumber(year, n) === s ? { year, n } : null
}
