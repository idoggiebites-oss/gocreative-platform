import { expect, test } from 'vitest'
import { ANALYZER_VERSION } from './artworkAnalysis'
import { validationCsv, validationSummary, wilson } from './artworkValidation'
import type { ArtworkReport } from './inquiry'

const report = (n: number | null, flags: ArtworkReport['flags'] = []): ArtworkReport => ({ analyzerVersion: ANALYZER_VERSION, estimatedInkColors: n, confidence: 'high', needsManualReview: n === null, flags })
const row = (actual: number | null, r: ArtworkReport | null, refused: string | null = null) => ({ name: 'a.png', actual, report: r, refused })

test('only jobs with a known count are measured, by the same rule customers would get', () => {
  const s = validationSummary([row(2, report(2)), row(3, report(2)), row(5, report(3)), row(2, report(2, ['gradient'])), row(4, null, 'unsupported'), row(null, report(1))])
  expect(s).toMatchObject({ jobs: 5, counted: 3, manual: 2, exact: 1, withinOne: 2, wrongButPriced: 2, enough: false })
  expect(s.notes).toEqual(expect.arrayContaining([{ note: 'gradient', jobs: 1, manual: 1, wrong: 0 }, { note: 'unsupported', jobs: 1, manual: 1, wrong: 0 }]))
})

test('30 jobs is the floor, and the range stays honest about a small sample', () => {
  expect(validationSummary(Array.from({ length: 29 }, () => row(1, report(1)))).enough).toBe(false)
  const full = validationSummary(Array.from({ length: 30 }, () => row(1, report(1))))
  expect(full.enough).toBe(true)
  expect(full.exactRange![0]).toBeGreaterThan(0.87) // 30 of 30 is not "100% accurate"
  expect(full.exactRange![0]).toBeLessThan(0.9)
  expect(wilson(0, 0)).toBeNull()
})

test('the download can\'t carry a spreadsheet formula, and names no one but the file', () => {
  const csv = validationCsv([{ name: '=HYPERLINK("x")', actual: 2, report: report(2), refused: null }])
  expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
  expect(csv.split('\n')).toHaveLength(2)
})
