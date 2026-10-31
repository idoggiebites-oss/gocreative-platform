import { Link } from 'react-router'
import type { AttentionReason, DashboardMetrics, NeedsAttentionRow } from '@shared/api'
import { useI18n } from '@/i18n'
import { useDashboard } from '@/lib/api'
import QueryBoundary from './QueryBoundary'
import { CARD, Chip, MUTED, PAGE, Sentence, TD, TH, useRowLink, type Tone } from './ui'

const REASON_TONE: Record<AttentionReason, Tone> = {
  overdue: 'red', artwork_changes_requested: 'red', po_waiting: 'amber', new_inquiry: 'blue', ready_waiting: 'green', quote_waiting: 'amber',
}

function Kpis({ metrics: k }: { metrics: DashboardMetrics }) {
  const { m, fmt } = useI18n()
  const s = m.dash.sub
  const artwork = k.artworkAwaitingApproval
  // [label, value, subline, subline is a warning]
  const cells: [string, number, string, boolean][] = [
    [m.dash.kpi.active, k.activeOrders, s.active, false],
    [m.dash.kpi.quotes, k.pendingQuotes, s.quotes, false],
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
        <div className="overflow-x-auto">
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
