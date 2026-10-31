import { useState } from 'react'
import type { UseMutationResult } from '@tanstack/react-query'
import type { ProductionJob } from '@shared/api'
import { useI18n } from '@/i18n'
import { ApiError, isConflict, useMe, useMoveProduction, useStartProduction, useUnitsCompleted } from '@/lib/api'
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

/**
 * The typed count. Its draft and the version it was read at are captured together (useEditSession), so a background
 * refetch never lets it overwrite someone else's newer count; a 409 shows the notice and loads the fresh count.
 */
function UnitsDraft({ job, w, onDirty, onSaved }: { job: ProductionJob; w: UseMutationResult<unknown, Error, { unitsCompleted: number; expectedVersion: number }>; onDirty: () => void; onSaved: () => void }) {
  const { m } = useI18n()
  const t = m.production.units
  const ed = useEditSession(job.version, () => String(job.unitsCompleted))
  const typed = ed.values.trim() === '' ? NaN : Number(ed.values)
  return (
    <>
      <form className="flex items-center gap-2" onSubmit={(e) => {
        e.preventDefault()
        if (w.isPending || ed.blocked || !Number.isFinite(typed)) return
        ed.clear()
        w.mutate({ unitsCompleted: typed, expectedVersion: ed.version }, { onSuccess: onSaved, onError: ed.onError })
      }}>
        <input
          className={cn(INPUT, 'num w-20')} inputMode="numeric" aria-label={`${t.input}: ${job.number}`} value={ed.values} aria-describedby={`uh-${job.number}`}
          onChange={(e) => { onDirty(); ed.setValues(e.target.value) }}
        />
        <button type="submit" className={BTN} disabled={w.isPending || ed.blocked || !Number.isFinite(typed)}>{t.save}</button>
      </form>
      <div className="basis-full empty:hidden"><ConflictNotice show={ed.conflict} /></div>
    </>
  )
}

/** Progress bar plus the editable count (in production or quality control). The ±10 buttons send the rendered job's version; the typed count sends the version it was started from. */
export function UnitsEditor({ job, readOnly }: { job: ProductionJob; readOnly?: boolean }) {
  const { m } = useI18n()
  const t = m.production.units
  const w = useUnitsCompleted(job.number)
  // Not dirty: the draft follows the job (a new epoch, so a fresh draft, on every new version). Dirty: it keeps its text and its version.
  const [dirty, setDirty] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const [seen, setSeen] = useState(job.version)
  if (!dirty && seen !== job.version) { setSeen(job.version); setEpoch((e) => e + 1) }
  const total = job.totalQuantity
  // The typed draft shows its own ConflictNotice; a ±10 click has none, so its refusal (a conflict too) is shown here.
  const [clickError, setClickError] = useState<Error | null>(null)
  const save = (n: number) => { if (w.isPending) return; setClickError(null); w.mutate({ unitsCompleted: n, expectedVersion: job.version }, { onError: setClickError }) }
  const pct = total > 0 ? Math.min(100, Math.round((job.unitsCompleted / total) * 100)) : 0
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
        <UnitsDraft
          key={epoch} job={job} w={w} onDirty={() => { setDirty(true); setClickError(null) }} // typing starts a new attempt: an old click refusal no longer applies
          onSaved={() => setDirty(false)}
        />
        <span id={`uh-${job.number}`} className={MUTED}>{t.hint(total)}</span>
      </div>}
      <ProdError error={clickError ?? (isConflict(w.error) ? null : w.error)} />
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
  const n = job.number
  const aria = (a: string) => t.ariaFor(a, n)
  const busy = start.isPending || move.isPending
  const s = job.productionStatus
  const startsAJob = s === 'ready' || s === 'quality_control'
  // The slot a start needs is held by another job (a job in QC holds none).
  const slot1Taken = running.some((j) => j.number !== n && j.slot === 1)
  const canOverride = startsAJob && me.data?.role === 'owner' && slot1Taken && running.length < 2
  const go = (to: 'quality_control' | 'production_complete') => !busy && move.mutate({ to, expectedVersion: job.version })
  // Pause returns to what readiness said in this row; the server re-checks it and refuses (409, refetch) if it has moved.
  const pause = () => !busy && move.mutate({ to: job.preProductionStatus, expectedVersion: job.version })
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
        {s === 'in_production' && <button type="button" aria-label={aria(t.pause)} aria-busy={busy || undefined} className={sm} onClick={pause}>{t.pause}</button>}
        {s === 'quality_control' && <button type="button" aria-label={aria(t.complete)} aria-busy={busy || undefined} className={smPrimary} onClick={() => go('production_complete')}>{t.complete}</button>}
      </div>
      <ProdError error={start.error ?? move.error} />
      {dialog && <OverrideDialog job={job} onClose={() => setDialog(false)} />}
    </div>
  )
}
