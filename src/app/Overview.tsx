import { Link } from 'react-router'
import type { ActionRequired as ActionRequiredData, ActionRow, AttentionReason, DashboardMetrics, NeedsAttentionRow, ProductionJob } from '@shared/api'
import { useI18n } from '@/i18n'
import { useDashboard } from '@/lib/api'
import { H2, SEC } from './form'
import { CurrentJob } from './Production'
import { useJobSummary } from './ProductionControls'
import QueryBoundary from './QueryBoundary'
import { CARD, Chip, MUTED, PAGE, Sentence, StackedRows, TD, TH, useRowLink, type Tone } from './ui'

const REASON_TONE: Record<AttentionReason, Tone> = {
  overdue: 'red', artwork_changes_requested: 'red', po_waiting: 'amber', new_inquiry: 'blue', ready_waiting: 'green', quote_waiting: 'amber',
}

function Kpis({ metrics: k }: { metrics: DashboardMetrics }) {
  const { m, fmt } = useI18n()
  const s = m.dash.sub
  const artwork = k.artworkAwaitingApproval
  // [label, value, subline, subline is a warning]
  const cells: [string, number, string, boolean][] = [
    [m.dash.kpi.active, k.activeOrders, k.activeOrdersNewThisWeek > 0 ? s.newThisWeek(k.activeOrdersNewThisWeek) : s.active, false],
    [m.dash.kpi.quotes, k.pendingQuotes, k.pendingQuotesWaitingOver5Days > 0 ? s.waitingOver5Days(k.pendingQuotesWaitingOver5Days) : s.quotes, false],
    [m.dash.kpi.artwork, artwork.pending + artwork.changesRequested, artwork.changesRequested > 0 ? s.changesRequested(artwork.changesRequested) : s.noChangesRequested, artwork.changesRequested > 0],
    [m.dash.kpi.pos, k.posAwaitingApproval.count, k.posAwaitingApproval.count > 0 ? s.held(fmt.money(k.posAwaitingApproval.amountCents)) : s.noPoAmount, false],
    [m.dash.kpi.production, k.inProduction.count, k.inProduction.qc > 0 ? s.qc(k.inProduction.qc) : s.noQc, false],
    [m.dash.kpi.due, k.dueIn7Days.count, k.dueIn7Days.overdue > 0 ? s.overdue(k.dueIn7Days.overdue) : s.noOverdue, k.dueIn7Days.overdue > 0],
    [m.dash.kpi.ready, k.readyForPickup.count, k.readyForPickup.oldestDaysWaiting !== undefined ? s.oldest(k.readyForPickup.oldestDaysWaiting) : s.none, false],
  ]
  return (
    <section aria-label={m.dash.overview} className={`${CARD} grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))]`}>
      {cells.map(([label, value, sub, warn]) => (
        <div key={label} className="flex flex-col gap-1 border-r border-secondary px-4 py-3.5 last:border-r-0">
          <span className={MUTED}>{label}</span>
          <span className="num text-2xl font-semibold tracking-[-0.02em]" data-kpi={value}>{value}</span>
          <span className={warn ? 'text-xs text-status-red-fg' : MUTED}>{sub}</span>
        </div>
      ))}
    </section>
  )
}

function Attention({ rows }: { rows: NeedsAttentionRow[] }) {
  const { m, fmt } = useI18n()
  const rowLink = useRowLink()
  const today = fmt.todayIso()
  return (
    <section aria-labelledby="att" className={`${CARD} min-w-0 flex-[999_1_560px]`}>
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5">
        <h2 id="att" className="text-sm font-semibold">{m.dash.attention}</h2>
        <Link to="/app/orders" className="text-[13px] text-primary no-underline hover:text-(--brand-hover)">{m.dash.allOrders}</Link>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-muted-foreground">{m.dash.nothingAttention}</p>
      ) : (
        <>
          <StackedRows rows={rows.map((r) => ({
            key: r.number ?? `inq-${r.inquiryId}`,
            to: r.number ? `/app/orders/${r.number}` : '/app/orders?view=inquiries',
            number: r.number ?? m.dash.inquiry,
            who: r.customerName || m.common.dash,
            sub: r.itemsSummary || r.title,
            chip: <Chip tone={REASON_TONE[r.reason]}>{m.dash.reason[r.reason](r.reasonDays)}</Chip>,
            due: r.dueDate ? <span className={r.dueDate < today ? 'font-medium text-status-red-fg' : ''}>{fmt.date(r.dueDate)}</span> : <span className="text-muted-foreground">{m.common.dash}</span>,
          }))} />
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full border-collapse text-[13px]">
            <thead><tr>
              <th className={TH}>{m.dash.cols.order}</th><th className={TH}>{m.dash.cols.customer}</th><th className={TH}>{m.dash.cols.why}</th><th className={TH}>{m.dash.cols.due}</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const to = r.number ? `/app/orders/${r.number}` : '/app/orders?view=inquiries'
                const overdue = r.dueDate !== null && r.dueDate < today
                return (
                  <tr key={r.number ?? `inq-${r.inquiryId}`} {...rowLink(to)}>
                    <td className={`${TD} h-11 num font-medium`}>
                      <Link to={to} className={r.number ? 'text-foreground no-underline hover:text-primary hover:underline' : 'text-muted-foreground no-underline hover:underline'}>{r.number ?? m.dash.inquiry}</Link>
                    </td>
                    <td className={`${TD} h-11`}>
                      <div className="flex flex-col"><span>{r.customerName || m.common.dash}</span>{(r.itemsSummary || r.title) && <span className={MUTED}>{r.itemsSummary || r.title}</span>}</div>
                    </td>
                    <td className={`${TD} h-11`}><Chip tone={REASON_TONE[r.reason]}>{m.dash.reason[r.reason](r.reasonDays)}</Chip></td>
                    <td className={`${TD} h-11 num ${overdue ? 'font-medium text-status-red-fg' : r.dueDate ? '' : 'text-muted-foreground'}`}>{r.dueDate ? fmt.date(r.dueDate) : m.common.dash}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
    </section>
  )
}

function DueWeek({ rows }: { rows: { number: string; customerName: string; dueDate: string }[] }) {
  const { m, fmt } = useI18n()
  const today = fmt.todayIso()
  const byDay = new Map<string, typeof rows>()
  for (const r of rows) byDay.set(r.dueDate, [...(byDay.get(r.dueDate) ?? []), r])
  const days = [...byDay]
  return (
    <section aria-labelledby="due" className={`${CARD} flex flex-col gap-3 px-4 py-3.5`}>
      <h2 id="due" className="text-sm font-semibold">{m.dash.dueWeek}</h2>
      {days.length === 0 ? <p className="text-[13px] text-muted-foreground">{m.dash.nothingDue}</p> : (
        <div className="flex flex-col gap-2.5 text-[13px]">
          {days.map(([date, items]) => (
            <div key={date} className="flex gap-3">
              <span className="w-[52px] flex-none pt-0.5 text-xs text-muted-foreground">{date === today ? m.common.today : fmt.dayLabel(date)}</span>
              <div className="flex min-w-0 flex-col gap-1.5">
                {items.map((r) => (
                  <Link key={r.number} to={`/app/orders/${r.number}`} className="truncate text-foreground no-underline hover:text-primary">
                    <b className="num font-medium">{r.number}</b> {r.customerName}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function Activity({ rows }: { rows: { actor: string; action: string; orderNumber: string | null; createdAt: string }[] }) {
  const { m, fmt } = useI18n()
  // Action codes come from the server as plain strings; a code with no sentence falls back to a generic one.
  const sentences: Record<string, ((n: string) => string) | undefined> = m.activity
  return (
    <section aria-labelledby="act" className={`${CARD} flex flex-col gap-3 px-4 py-3.5`}>
      <h2 id="act" className="text-sm font-semibold">{m.dash.activity}</h2>
      {rows.length === 0 ? <p className="text-[13px] text-muted-foreground">{m.dash.nothingActivity}</p> : (
        <ul className="flex flex-col gap-3 text-[13px]">
          {rows.map((r, i) => {
            const n = r.orderNumber ?? ''
            const text = (sentences[r.action] ?? m.activity.other)(n)
            return (
              <li key={i} className="flex flex-col gap-0.5">
                <span><Sentence text={text} n={n} /></span>
                <span className={MUTED}>{r.actor} · {fmt.relative(r.createdAt)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function CurrentProduction({ jobs }: { jobs: ProductionJob[] }) {
  const { m } = useI18n()
  return (
    <section aria-labelledby="cur" className={`${CARD} border-[#C9D4F2]`}>
      <div className={SEC}>
        <h2 id="cur" className={H2}>{m.dash.current.title}</h2>
        <Link to="/app/production" className="text-[13px] text-primary no-underline hover:text-(--brand-hover)">{m.production.productionPage}</Link>
      </div>
      {jobs.length === 0 ? <p className="px-4 pb-4 text-[13px] text-muted-foreground">{m.dash.current.none}</p> : (
        <ul aria-label={m.dash.current.title}>{jobs.map((j) => <CurrentJob key={j.number} job={j} running={jobs} readOnly />)}</ul>
      )}
    </section>
  )
}

function Upcoming({ jobs }: { jobs: ProductionJob[] }) {
  const { m } = useI18n()
  const sum = useJobSummary()
  return (
    <section aria-labelledby="upn" className={CARD}>
      <div className={SEC}>
        <h2 id="upn" className={H2}>{m.dash.upcoming.title}</h2>
        <Link to="/app/production" className="text-[13px] text-primary no-underline hover:text-(--brand-hover)">{m.production.productionPage}</Link>
      </div>
      {jobs.length === 0 ? <p className="px-4 pb-4 text-[13px] text-muted-foreground">{m.dash.upcoming.empty}</p> : (
        <ol aria-label={m.dash.upcoming.title}>
          {jobs.map((j, i) => (
            <li key={j.number} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-secondary px-4 py-2.5 text-[13px] first:border-t-0">
              <span className="num w-4 flex-none text-muted-foreground">{i + 1}</span>
              <div className="flex min-w-0 flex-[1_1_220px] flex-col">
                <span className="flex flex-wrap items-baseline gap-x-2"><Link to={`/app/orders/${j.number}`} className="num font-medium text-foreground no-underline hover:text-primary hover:underline">{j.number}</Link><span>{j.customerName}</span></span>
                <span className={MUTED}>{j.title} · {sum.what(j)}</span>
              </div>
              <span className="num">{sum.due(j)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

const MORE_ROWS = 3

/** The groups the server lists; an empty group renders nothing (the M5 groups stay hidden until they have rows). */
function ActionRequired({ data }: { data: ActionRequiredData }) {
  const { m, fmt } = useI18n()
  const t = m.dash.action
  const groups: { key: keyof ActionRequiredData; rows: (ActionRow & { why?: string })[] }[] = [
    { key: 'quotes', rows: data.quotes.map((r) => ({ ...r, why: r.quoteStatus ? m.labels.quoteStatus[r.quoteStatus] : t.noQuote })) },
    { key: 'missingArtwork', rows: data.missingArtwork.map((r) => ({ ...r, why: m.labels.artworkStatus[r.artworkStatus] })) },
    { key: 'pendingPos', rows: data.pendingPos.map((r) => ({ ...r, why: r.poStatus ? m.labels.poStatus[r.poStatus] : t.noPo })) },
    { key: 'materialsAwaiting', rows: data.materialsAwaiting.map((r) => ({ ...r, why: t.materials })) },
    { key: 'awaitingPickup', rows: data.awaitingPickup },
    { key: 'checksToCollect', rows: data.checksToCollect },
  ]
  const shown = groups.filter((g) => g.rows.length > 0)
  if (shown.length === 0) return null
  return (
    <section aria-labelledby="req" className={CARD}>
      <div className={SEC}><h2 id="req" className={H2}>{t.title}</h2></div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))]">
        {shown.map((g) => (
          <div key={g.key} role="group" aria-label={t.groups[g.key]} className="flex min-w-0 flex-col gap-2 border-t border-secondary px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[13px] font-semibold">{t.groups[g.key]}</h3>
              <Chip tone="gray">{t.count(g.rows.length)}</Chip>
            </div>
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {g.rows.slice(0, MORE_ROWS).map((r) => (
                <li key={r.number}>
                  <Link to={`/app/orders/${r.number}`} className="flex min-w-0 flex-col text-foreground no-underline hover:text-primary">
                    <span className="truncate"><b className="num font-medium">{r.number}</b> {r.customerName}</span>
                    <span className={MUTED}>{[r.why, r.dueDate ? m.production.due(fmt.date(r.dueDate)) : null].filter(Boolean).join(' · ')}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {g.rows.length > MORE_ROWS && <Link to="/app/orders" className="text-xs text-primary no-underline hover:text-(--brand-hover)">{t.more(g.rows.length - MORE_ROWS)}</Link>}
          </div>
        ))}
      </div>
    </section>
  )
}

export default function Overview() {
  const { m, fmt } = useI18n()
  const query = useDashboard()
  const now = new Date()
  const h = now.getHours()
  const greeting = h < 12 ? m.dash.greeting.morning : h < 18 ? m.dash.greeting.afternoon : m.dash.greeting.evening
  return (
    <QueryBoundary query={query}>
      {(d) => (
        <div className={PAGE}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-xl font-semibold tracking-[-0.015em]">{greeting}</h1>
            <span className="text-[13px] text-muted-foreground">{fmt.longDate(now)}</span>
          </div>
          <Kpis metrics={d.metrics} />
          <CurrentProduction jobs={d.currentJobs} />
          <Upcoming jobs={d.upcoming} />
          <ActionRequired data={d.actionRequired} />
          <div className="flex flex-wrap items-start gap-5">
            <Attention rows={d.needsAttention} />
            <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-5">
              <DueWeek rows={d.dueThisWeek} />
              <Activity rows={d.recentActivity} />
            </div>
          </div>
        </div>
      )}
    </QueryBoundary>
  )
}
