// Measures the color count against real jobs, by the rule customers would get (defensibleColors). It says nothing about rates, limits or margin checks, which can still send a job to a person. Pure: no file ever reaches it.
import type { ArtworkReport } from './inquiry'
import { defensibleColors } from './inquiry'

export const MIN_JOBS = 30
/** `hash` identifies the file's bytes, so choosing one file thirty times can't look like thirty jobs. */
export type ValidationRow = { name: string; actual: number | null; report: ArtworkReport | null; refused: string | null; hash?: string | null }

/** Wilson 95% interval: with 30 jobs a single percentage hides how little is known. Null with nothing to measure. */
export function wilson(hits: number, n: number): [number, number] | null {
  if (n === 0) return null
  const z = 1.96
  const p = hits / n
  const d = 1 + (z * z) / n
  const mid = p + (z * z) / (2 * n)
  const off = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, (mid - off) / d), Math.min(1, (mid + off) / d)]
}

export function validationSummary(rows: readonly ValidationRow[]) {
  const jobs = rows.filter((r) => r.actual !== null)
  const counted = jobs.filter((r) => defensibleColors(r.report) !== null)
  const off = (r: ValidationRow) => Math.abs(defensibleColors(r.report)! - r.actual!)
  const exact = counted.filter((r) => off(r) === 0).length
  const distinct = new Set(jobs.map((r, i) => r.hash ?? `row-${i}`)).size
  const notes = new Map<string, { jobs: number; manual: number; wrong: number }>()
  for (const r of jobs) {
    for (const note of r.refused ? [r.refused] : r.report?.flags ?? []) {
      const n = notes.get(note) ?? { jobs: 0, manual: 0, wrong: 0 }
      n.jobs++
      if (defensibleColors(r.report) === null) n.manual++
      else if (off(r) !== 0) n.wrong++
      notes.set(note, n)
    }
  }
  return {
    jobs: jobs.length, counted: counted.length, manual: jobs.length - counted.length, exact, withinOne: counted.filter((r) => off(r) <= 1).length,
    /** The number that matters most: the analysis gave a count, and it was wrong. */
    wrongCount: counted.length - exact, exactRange: wilson(exact, counted.length), distinct, enough: distinct >= MIN_JOBS, notes: [...notes].map(([note, n]) => ({ note, ...n })),
  }
}

/** A spreadsheet can run a cell that starts with these, and a file name is whatever the customer called it. */
const cell = (v: string | number | null) => {
  const s = v === null ? '' : String(v)
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`
}
export const validationCsv = (rows: readonly ValidationRow[]) => [
  ['file', 'screens_used', 'analyzer_version', 'count_given', 'estimated_ink_colors', 'confidence', 'notes'].join(','),
  ...rows.map((r) => [cell(r.name), cell(r.actual), cell(r.report?.analyzerVersion ?? null), cell(defensibleColors(r.report)), cell(r.report?.estimatedInkColors ?? null), cell(r.report?.confidence ?? null), cell((r.refused ? [r.refused] : r.report?.flags ?? []).join(' '))].join(',')),
].join('\n')
