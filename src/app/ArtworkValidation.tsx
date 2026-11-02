// Settings > Pricing: the check of the artwork analysis against real jobs. Files stay in this browser. Only the results are remembered here, and only on this computer.
import { useEffect, useState } from 'react'
import { MIN_JOBS, validationCsv, validationSummary, type ValidationRow } from '@shared/artworkValidation'
import { defensibleColors } from '@shared/inquiry'
import { analyzeFile, reportOf } from '@/lib/artworkAnalyzer'
import { useI18n } from '@/i18n'
import { BTN, H2, INPUT, SEC } from './form'
import { CARD, MUTED, TD, TH } from './ui'

const KEY = 'artwork-validation'
type CheckRow = ValidationRow & { done: boolean }
const load = (): CheckRow[] => {
  try {
    const rows = JSON.parse(localStorage.getItem(KEY) ?? '[]') as ValidationRow[]
    return Array.isArray(rows) ? rows.map((r) => ({ ...r, done: true })) : []
  } catch {
    return []
  }
}

export default function ArtworkValidation() {
  const { m } = useI18n()
  const t = m.pricing
  const [rows, setRows] = useState<CheckRow[]>(load)
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(rows.filter((r) => r.done).map(({ done: _, ...r }) => r))) } catch { /* private mode: results last until the page closes, and the CSV still works */ }
  }, [rows])
  const busy = rows.some((r) => !r.done) // one batch at a time, so a large selection can't exhaust the browser
  const add = (files: File[]) => {
    const start = rows.length
    setRows((r) => [...r, ...files.map((f) => ({ name: f.name, actual: null, report: null, refused: null, done: false }))])
    files.reduce(async (prev, f, i) => { // one at a time, so a batch can't exhaust the browser
      await prev
      const outcome = await analyzeFile(f)
      const bytes = await crypto.subtle.digest('SHA-256', await f.arrayBuffer())
      const hash = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
      setRows((r) => r.map((x, j) => (j === start + i ? { ...x, done: true, hash, report: reportOf(outcome), refused: 'refused' in outcome ? outcome.refused : null } : x)))
    }, Promise.resolve())
  }
  const s = validationSummary(rows.filter((r) => r.done))
  const percent = (v: number) => `${Math.round(v * 100)}%`
  const download = () => {
    const url = URL.createObjectURL(new Blob([validationCsv(rows)], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'artwork-validation.csv'
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <section className={CARD} aria-labelledby="pricing-check">
      <div className={SEC}><h2 id="pricing-check" className={H2}>{t.check}</h2></div>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className={MUTED}>{t.checkHelp}</p>
        <div className="flex flex-wrap gap-2">
          <label className={`${BTN} cursor-pointer`}>{busy ? t.analyzing : t.chooseFiles}<input type="file" multiple disabled={busy} accept=".png,.jpg,.jpeg,.svg,.pdf" className="sr-only" onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = '' }} /></label>
          {rows.length > 0 && <button type="button" className={BTN} disabled={busy} onClick={download}>{t.downloadResults}</button>}
          {rows.length > 0 && <button type="button" className={BTN} disabled={busy} onClick={() => setRows([])}>{t.clearResults}</button>}
        </div>
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead><tr className="bg-header"><th className={TH}>{t.file}</th><th className={TH}>{t.known}</th><th className={TH}>{t.detected}</th><th className={TH}>{t.flagsCol}</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className={`${TD} whitespace-normal`}>{r.name}</td>
                    <td className={TD}><input aria-label={`${t.known}: ${r.name}`} className={`${INPUT} w-16`} inputMode="numeric" value={r.actual ?? ''} onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 3); setRows(rows.map((x, j) => (j === i ? { ...x, actual: v === '' ? null : Number(v) } : x))) }} /></td>
                    <td className={`${TD} num`}>{!r.done ? t.analyzing : defensibleColors(r.report) ?? t.manual}</td>
                    <td className={`${TD} whitespace-normal`}>{(r.refused ? [r.refused] : r.report?.flags ?? []).map((f) => t.flags[f] ?? f).join(', ') || m.common.dash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {s.jobs > 0 && (
          <div className="flex flex-col gap-1 text-[13px]">
            <p data-testid="check-summary">{t.measured}: {s.jobs}. {t.exact}: {s.exact}. {t.withinOne}: {s.withinOne}. {t.refused}: {s.manual}.</p>
            <p data-testid="check-risk"><strong>{t.wrongCount}: {s.wrongCount}.</strong>{s.exactRange && ` ${t.exactRange(s.counted, percent(s.exactRange[0]), percent(s.exactRange[1]))}`}</p>
            <p data-testid="check-enough" className={MUTED}>{s.enough ? t.enoughJobs : t.notEnoughJobs(s.jobs, MIN_JOBS)}</p>
            {s.notes.length > 0 && (
              <ul data-testid="check-notes" className={MUTED}>
                {s.notes.map((n) => <li key={n.note}>{t.flags[n.note] ?? n.note}: {t.noteLine(n.jobs, n.manual, n.wrong)}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
