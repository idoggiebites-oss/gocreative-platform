// Parse decimal digits directly so rounding cannot change an agreed price.
export function parseDollarsToCents(input: string): number | null {
  const match = /^\$?(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(input.trim())
  if (!match) return null
  const cents = BigInt(match[1].replaceAll(',', '')) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null
}

export function formatCentsPlain(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('Invalid cents')
  const value = BigInt(cents)
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`
}
