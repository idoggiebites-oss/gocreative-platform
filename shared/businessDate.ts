import { business } from './business.ts'

export function businessToday(now: Date, timeZone: string = business.timeZone): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (type: string) => parts.find(p => p.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function calendarDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Invalid business date')
  const date = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new RangeError('Invalid business date')
  return date
}

export function addDays(date: string, n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError('Invalid day count')
  const result = calendarDate(date)
  result.setUTCDate(result.getUTCDate() + n)
  if (!Number.isFinite(result.getTime()) || result.getUTCFullYear() < 0 || result.getUTCFullYear() > 9999) throw new RangeError('Date out of range')
  return result.toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  // Midnight UTC represents a calendar day, independent of shop DST changes.
  return (calendarDate(to).getTime() - calendarDate(from).getTime()) / 86_400_000
}
