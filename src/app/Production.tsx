import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { ProductionJob } from '@shared/api'
import { useI18n } from '@/i18n'
import { isConflict, useProduction, useReorderQueue } from '@/lib/api'
import { cn } from '@/lib/utils'
import { BTN, BTN_SM, H2, MutationError, SEC } from './form'
import { JobActions, UnitsEditor, useJobSummary } from './ProductionControls'
import QueryBoundary from './QueryBoundary'
import { CARD, Chip, MUTED, PAGE, PRODUCTION_TONE } from './ui'

/** The active job, prominent. Read-only on the dashboard (progress and a link); full controls on the Production page. */
export function CurrentJob({ job, running, readOnly }: { job: ProductionJob; running: ProductionJob[]; readOnly?: boolean }) {
  const { m, fmt } = useI18n()
  const sum = useJobSummary()
  const t = m.production
  return (
    <li className="flex flex-col gap-3 border-t border-secondary px-4 py-4 first:border-t-0">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Link to={`/app/orders/${job.number}`} className="num text-lg font-semibold text-primary no-underline hover:text-(--brand-hover)">{job.number}</Link>
            <span className="text-[15px] font-medium">{job.customerName}</span>
            <Chip tone={PRODUCTION_TONE[job.productionStatus]}>{m.labels.productionStatus[job.productionStatus]}</Chip>
          </div>
          <span className="text-[13px]">{job.title} · {sum.what(job)}</span>
          <span className={MUTED}>{sum.due(job)}{job.startedAt && ` · ${t.started(fmt.relative(job.startedAt))}`}</span>
          {job.override && (
            <p className="rounded-[7px] bg-status-amber px-2.5 py-2 text-[12.5px] text-status-amber-fg"><b className="font-semibold">{t.override.badge}.</b> {t.override.by(job.override.by, job.override.reason)}</p>
          )}
          {job.latestNote && <p className="rounded-[7px] bg-background px-2.5 py-2 text-[13px]"><span className={MUTED}>{t.notes}</span><br />{job.latestNote.body}</p>}
        </div>
        <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-3">
          <UnitsEditor job={job} readOnly={readOnly} />
          {readOnly
            ? <Link to={`/app/orders/${job.number}`} className={cn(BTN, 'self-start')}>{t.openOrder}</Link>
            : (
              <div className="flex flex-wrap items-start gap-2 border-t border-secondary pt-3">
                <JobActions job={job} running={running} />
                <Link to={`/app/orders/${job.number}`} className={cn(BTN, BTN_SM)}>{t.openOrder}</Link>
              </div>
            )}
        </div>
      </div>
    </li>
  )
}

function ReadyRow({ job, index, last, running, move, busy }: { job: ProductionJob; index: number; last: boolean; running: ProductionJob[]; move: (dir: -1 | 1) => void; busy: boolean }) {
  const { m } = useI18n()
  const sum = useJobSummary()
  const arrow = cn(BTN, 'size-8 px-0')
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-secondary px-4 py-3 first:border-t-0">
      <span className="flex flex-none items-center gap-1">
        <button type="button" className={arrow} disabled={busy || index === 0} aria-label={m.production.ariaFor(m.production.moveUp, job.number)} onClick={() => move(-1)}><ArrowUp className="size-4" strokeWidth={1.75} aria-hidden /></button>
        <button type="button" className={arrow} disabled={busy || last} aria-label={m.production.ariaFor(m.production.moveDown, job.number)} onClick={() => move(1)}><ArrowDown className="size-4" strokeWidth={1.75} aria-hidden /></button>
      </span>
      <span className="num w-5 flex-none text-[13px] text-muted-foreground" title={m.production.position(index + 1)}>{index + 1}</span>
      <div className="flex min-w-0 flex-[1_1_220px] flex-col text-[13px]">
        <span className="flex flex-wrap items-baseline gap-x-2"><Link to={`/app/orders/${job.number}`} className="num font-medium text-foreground no-underline hover:text-primary hover:underline">{job.number}</Link><span>{job.customerName}</span></span>
        <span className={MUTED}>{job.title} · {sum.what(job)}</span>
      </div>
      <span className="num flex-none text-[13px]">{sum.due(job)}</span>
      <JobActions job={job} running={running} />
    </li>
  )
}

const INTERACTIVE = 'a[href], button, input, select, textarea, [contenteditable="true"], [role="tab"], [role="menuitem"]'

function ReadyList({ jobs, running }: { jobs: ProductionJob[]; running: ProductionJob[] }) {
  const { m } = useI18n()
  const reorder = useReorderQueue()
  // Moving a row re-renders the list and the browser drops focus from the button just used (or it is now disabled at the end):
  // put it back on that job's move button, or on its other one.
  const refocus = useRef<{ number: string; dir: -1 | 1; from: Element | null } | null>(null)
  // Only while the user has not moved on: a focus move to anything but the control they pressed cancels the restore.
  // A container useKeepFocus parks focus on while the arrows are disabled isn't the user moving on (Codex review of eb85479).
  const userTarget = (el: EventTarget | Element | null) => el instanceof Element && el.matches(INTERACTIVE)
  useEffect(() => {
    const onIn = (e: FocusEvent) => { if (refocus.current && e.target !== refocus.current.from && userTarget(e.target)) refocus.current = null }
    document.addEventListener('focusin', onIn)
    return () => document.removeEventListener('focusin', onIn)
  }, [])
  useEffect(() => {
    const r = refocus.current
    if (!r || reorder.isPending) return
    refocus.current = null
    const a = document.activeElement
    if (a && a !== document.body && a !== r.from && userTarget(a)) return
    const label = (d: -1 | 1) => m.production.ariaFor(d === -1 ? m.production.moveUp : m.production.moveDown, r.number)
    const find = (d: -1 | 1) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label(d)}"]:not(:disabled)`)
    ;(find(r.dir) ?? find(r.dir === -1 ? 1 : -1))?.focus()
  }, [jobs, reorder.isPending, m])
  const move = (i: number, dir: -1 | 1) => {
    refocus.current = { number: jobs[i].number, dir, from: document.activeElement }
    const next = jobs.map((j) => j.number)
    ;[next[i], next[i + dir]] = [next[i + dir], next[i]]
    reorder.mutate({ seen: jobs.map((j) => j.number), orderNumbers: next })
  }
  return (
    <section aria-labelledby="rs" className={CARD}>
      <div className={SEC}><h2 id="rs" className={H2}>{m.production.readyTitle}</h2><span className={MUTED}>{m.production.readyCount(jobs.length)}</span></div>
      {jobs.length === 0 ? <p className="px-4 pb-4 text-[13px] text-muted-foreground">{m.production.readyEmpty}</p> : (
        <>
          <p className={cn(MUTED, 'px-4 pb-2')}>{running.length > 0 ? m.production.oneAtATime : m.production.reorderHint}</p>
          <ul aria-label={m.production.readyTitle}>
            {jobs.map((j, i) => <ReadyRow key={j.number} job={j} index={i} last={i === jobs.length - 1} running={running} busy={reorder.isPending} move={(d) => move(i, d)} />)}
          </ul>
        </>
      )}
      <div className="px-4 pb-3 empty:hidden" aria-live="polite">
        {isConflict(reorder.error)
          ? <p role="alert" className="rounded-[7px] bg-status-amber px-2.5 py-2 text-[12.5px] text-status-amber-fg">{m.production.queueChanged}</p>
          : <MutationError error={reorder.error} />}
      </div>
    </section>
  )
}

function Completed({ jobs, running }: { jobs: ProductionJob[]; running: ProductionJob[] }) {
  const { m } = useI18n()
  const sum = useJobSummary()
  return (
    <section aria-labelledby="cd" className={CARD}>
      <div className={SEC}><h2 id="cd" className={H2}>{m.production.completedTitle}</h2></div>
      {jobs.length === 0 ? <p className="px-4 pb-4 text-[13px] text-muted-foreground">{m.production.completedEmpty}</p> : (
        <ul>
          {jobs.map((j) => (
            <li key={j.number} className="flex flex-col gap-2 border-t border-secondary px-4 py-3 first:border-t-0">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex min-w-0 flex-[1_1_220px] flex-col text-[13px]">
                  <span className="flex flex-wrap items-baseline gap-x-2"><Link to={`/app/orders/${j.number}`} className="num font-medium text-foreground no-underline hover:text-primary hover:underline">{j.number}</Link><span>{j.customerName}</span></span>
                  <span className={MUTED}>{j.title} · {sum.what(j)}</span>
                </div>
                <Chip tone={PRODUCTION_TONE[j.productionStatus]}>{m.labels.productionStatus[j.productionStatus]}</Chip>
                <JobActions job={j} running={running} />
              </div>
              {j.productionStatus === 'quality_control' && <UnitsEditor job={j} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function Production() {
  const { m } = useI18n()
  const query = useProduction()
  return (
    <QueryBoundary query={query}>
      {(d) => (
        <div className={PAGE}>
          <h1 className="text-xl font-semibold tracking-[-0.015em]">{m.production.title}</h1>
          <section aria-labelledby="cp" className={cn(CARD, 'border-[#C9D4F2]')}>
            <div className={SEC}><h2 id="cp" className={H2}>{m.production.currentTitle}</h2><Chip tone="blue">{m.production.activeJobs(d.current.length)}</Chip></div>
            {d.current.length === 0 ? <p className="px-4 pb-4 text-[13px] text-muted-foreground">{m.production.nothingRunning}</p> : (
              <ul aria-label={m.production.currentTitle}>{d.current.map((j) => <CurrentJob key={j.number} job={j} running={d.current} />)}</ul>
            )}
          </section>
          <ReadyList jobs={d.readyToStart} running={d.current} />
          <Completed jobs={d.completed} running={d.current} />
        </div>
      )}
    </QueryBoundary>
  )
}
