import { useState } from 'react'
import type { ProductionJob } from '@shared/api'
import { useI18n } from '@/i18n'
import { ApiError, fetchPauseTarget, isConflict, useMe, useMoveProduction, useStartProduction, useUnitsCompleted } from '@/lib/api'
import { cn } from '@/lib/utils'
import { BTN, BTN_PRIMARY, BTN_SM, ConflictNotice, Field, FormDialog, INPUT, MutationError, TEXTAREA, useEditSession } from './form'
import { MUTED } from './ui'

const sm = cn(BTN, BTN_SM)
const smPrimary = cn(BTN, BTN_SM, BTN_PRIMARY)

/** One line about a job: product, method(s), pieces; and its due date. */
export function useJobSummary() {
  const { m, fmt } = useI18n()
  return {
    what: (j: ProductionJob) => [m.production.product(j.product.first, j.product.lines), j.methods.map((x) => m.labels.method[x]).join(', '), m.production.pieces(j.totalQuantity)].filter(Boolean).join(' · '),
    due: (j: ProductionJob) => (j.dueDate ? m.production.due(fmt.date(j.dueDate)) : m.production.noDue),
  }
}

/** The server's refusal: production_busy names the running job; everything else is the shared translated text. */
export function ProdError({ error }: { error: Error | null }) {
  const { m } = useI18n()
  if (error instanceof ApiError && error.body.code === 'production_busy' && error.body.runningJob) {
    return <span role="alert" className="text-xs text-status-red-fg">{m.production.busy(error.body.runningJob)}</span>
  }
  return <MutationError error={error} />
}

/** Progress bar plus the editable count (in production or quality control). Each save sends the rendered job's version. */
export function UnitsEditor({ job, readOnly }: { job: ProductionJob; readOnly?: boolean }) {
  const { m } = useI18n()
  const t = m.production.units
  const w = useUnitsCompleted(job.number)
  const [text, setText] = useState(String(job.unitsCompleted))
  const total = job.totalQuantity
  const save = (n: number) => !w.isPending && w.mutate({ unitsCompleted: n, expectedVersion: job.version }, { onSuccess: () => setText(String(n)) })
  const pct = total > 0 ? Math.min(100, Math.round((job.unitsCompleted / total) * 100)) : 0
  const typed = text.trim() === '' ? NaN : Number(text)
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium">{t.label}</span>
        <span className="num text-xl font-semibold tracking-[-0.015em]">{t.of(job.unitsCompleted, total)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-label={`${t.label}: ${job.number}`} aria-valuenow={job.unitsCompleted} aria-valuemin={0} aria-valuemax={total}>
        <i className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      {!readOnly && <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BTN} aria-label={`${t.minus}: ${job.number}`} disabled={w.isPending || job.unitsCompleted <= 0} onClick={() => save(Math.max(0, job.unitsCompleted - 10))}>− 10</button>
        <button type="button" className={BTN} aria-label={`${t.plus}: ${job.number}`} disabled={w.isPending || job.unitsCompleted >= total} onClick={() => save(Math.min(total, job.unitsCompleted + 10))}>+ 10</button>
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (Number.isFinite(typed)) save(typed) }}>
          <input
            className={cn(INPUT, 'num w-20')} inputMode="numeric" aria-label={`${t.input}: ${job.number}`} value={text} aria-describedby={`uh-${job.number}`}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className={BTN} disabled={w.isPending || !Number.isFinite(typed)}>{t.save}</button>
        </form>
        <span id={`uh-${job.number}`} className={MUTED}>{t.hint(total)}</span>
      </div>}
      <ProdError error={w.error} />
    </div>
  )
}

function OverrideDialog({ job, onClose }: { job: ProductionJob; onClose: () => void }) {
  const { m } = useI18n()
  const t = m.production.override
  const w = useStartProduction(job.number)
  const ed = useEditSession(job.version, () => '')
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={t.title(job.number)} description={t.body} submitLabel={t.submit} pending={w.isPending}
      error={isConflict(w.error) ? null : w.error} disabled={ed.blocked || !ed.values.trim()}
      onSubmit={() => { ed.clear(); w.mutate({ expectedVersion: ed.version, override: true, reason: ed.values.trim() }, { onSuccess: onClose, onError: ed.onError }) }}
    >
      <ConflictNotice show={ed.conflict} />
      <Field label={t.reason}><textarea className={TEXTAREA} rows={3} maxLength={500} required value={ed.values} onChange={(e) => ed.setValues(e.target.value)} /></Field>
    </FormDialog>
  )
}

/**
 * Every production action for one job, by its status: Start (ready), Send to QC and Pause (in production), Mark complete
 * and Restart (quality control). `running` is the list of jobs in production, so an owner is offered the override while
 * exactly one job runs. Immediate actions send the rendered job's version; a 409 refetches and shows the translated text.
 */
export function JobActions({ job, running }: { job: ProductionJob; running: ProductionJob[] }) {
  const { m } = useI18n()
  const t = m.production
  const me = useMe()
  const start = useStartProduction(job.number)
  const move = useMoveProduction(job.number)
  const [dialog, setDialog] = useState(false)
  const [pausing, setPausing] = useState(false)
  const n = job.number
  const aria = (a: string) => t.ariaFor(a, n)
  const busy = start.isPending || move.isPending || pausing
  const s = job.productionStatus
  const startsAJob = s === 'ready' || s === 'quality_control'
  // The slot a start needs is held by another job (a job in QC holds none).
  const slot1Taken = running.some((j) => j.number !== n && j.slot === 1)
  const canOverride = startsAJob && me.data?.role === 'owner' && slot1Taken && running.length < 2
  const go = (to: 'quality_control' | 'production_complete') => !busy && move.mutate({ to, expectedVersion: job.version })
  const pause = async () => {
    if (busy) return
    setPausing(true)
    try {
      move.mutate({ to: await fetchPauseTarget(n), expectedVersion: job.version })
    } catch { /* the read failed: nothing was sent, try again */ } finally { setPausing(false) }
  }
  const startLabel = s === 'ready' ? t.start : t.restart
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {startsAJob && (
          <button type="button" aria-label={aria(startLabel)} aria-busy={busy || undefined} className={s === 'ready' && !slot1Taken ? smPrimary : sm} onClick={() => !busy && start.mutate({ expectedVersion: job.version })}>
            {start.isPending ? t.starting : startLabel}
          </button>
        )}
        {canOverride && <button type="button" aria-label={aria(t.startOverride)} className={sm} onClick={() => setDialog(true)}>{t.startOverride}</button>}
        {s === 'in_production' && <button type="button" aria-label={aria(t.toQc)} aria-busy={busy || undefined} className={smPrimary} onClick={() => go('quality_control')}>{t.toQc}</button>}
        {s === 'in_production' && <button type="button" aria-label={aria(t.pause)} aria-busy={busy || undefined} className={sm} onClick={() => void pause()}>{t.pause}</button>}
        {s === 'quality_control' && <button type="button" aria-label={aria(t.complete)} aria-busy={busy || undefined} className={smPrimary} onClick={() => go('production_complete')}>{t.complete}</button>}
      </div>
      <ProdError error={start.error ?? move.error} />
      {dialog && <OverrideDialog job={job} onClose={() => setDialog(false)} />}
    </div>
  )
}
