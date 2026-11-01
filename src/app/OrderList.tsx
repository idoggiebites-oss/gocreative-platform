import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Search } from 'lucide-react'
import { ORDER_VIEWS, type InquiryListRow, type OrderListRow, type OrderView } from '@shared/api'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useOrders } from '@/lib/api'
import QueryBoundary from './QueryBoundary'
import { ARTWORK_TONE, CARD, Chip, MethodTag, MUTED, PAGE, PO_TONE, PRODUCTION_TONE, StackedRows, TD, TH, useRowLink } from './ui'

const isView = (v: string | null): v is OrderView => ORDER_VIEWS.includes(v as OrderView)

function OrdersTable({ rows }: { rows: OrderListRow[] }) {
  const { m, fmt } = useI18n()
  const rowLink = useRowLink()
  const today = fmt.todayIso()
  const c = m.orders.cols
  const dueOf = (r: OrderListRow) => {
    const overdue = r.dueDate !== null && r.dueDate < today && r.productionStatus !== 'production_complete'
    const text = r.dueDate === null ? m.common.dash : overdue ? `${fmt.date(r.dueDate)} · ${m.orders.overdue}` : r.dueDate === today ? m.common.today : fmt.date(r.dueDate)
    return { overdue, text }
  }
  return (
    <>
    <StackedRows rows={rows.map((r) => {
      const due = dueOf(r)
      return {
        key: r.number, to: `/app/orders/${r.number}`, number: r.number, who: r.customerName, sub: r.title,
        chip: <Chip tone={PRODUCTION_TONE[r.productionStatus]}>{m.labels.productionStatus[r.productionStatus]}</Chip>,
        due: <span className={cn(due.overdue && 'font-medium text-status-red-fg', r.dueDate === null && 'text-muted-foreground')}>{due.text}</span>,
      }
    })} />
    <table className="hidden w-full border-collapse text-[13px] sm:table">
      <thead><tr className="bg-header">
        <th className={TH}>{c.order}</th><th className={TH}>{c.customer}</th><th className={TH}>{c.items}</th><th className={TH}>{c.artwork}</th>
        <th className={TH}>{c.po}</th><th className={TH}>{c.production}</th><th className={TH}>{c.due}</th><th className={cn(TH, 'text-right')}>{c.quote}</th>
      </tr></thead>
      <tbody>
        {rows.map((r) => {
          const to = `/app/orders/${r.number}`
          const overdue = r.dueDate !== null && r.dueDate < today && r.productionStatus !== 'production_complete'
          return (
            <tr key={r.number} {...rowLink(to)}>
              <td className={`${TD} num font-medium`}>
                <Link to={to} className="text-foreground no-underline hover:text-primary hover:underline">{r.number}</Link>
              </td>
              <td className={TD}>
                <div className="flex max-w-[130px] flex-col leading-tight"><span className="truncate" title={r.customerName}>{r.customerName}</span><span className={`${MUTED} truncate`}>{r.title}</span></div>
              </td>
              <td className={TD}>{r.methods.slice(0, 1).map((x) => <MethodTag key={x}>{m.labels.method[x]}</MethodTag>)}{r.methods.length > 1 && <MethodTag>+{r.methods.length - 1}</MethodTag>}<span title={m.common.items(r.totalQty)}>{r.totalQty}</span></td>
              <td className={TD}>
                {r.artworkStatus === 'not_received' || r.artworkStatus === 'not_required'
                  ? <span className="text-xs text-muted-foreground">{m.labels.artworkStatus[r.artworkStatus]}</span>
                  : <Chip tone={ARTWORK_TONE[r.artworkStatus]}>{m.labels.artworkStatus[r.artworkStatus]}</Chip>}
              </td>
              <td className={TD}>
                {!r.poRequired ? <span className="text-xs text-muted-foreground">{m.orders.poNotRequired}</span>
                  : r.latestPoStatus === null ? <Chip tone="gray">{m.orders.poNotRequested}</Chip>
                  : <Chip tone={PO_TONE[r.latestPoStatus]}>{m.labels.poStatus[r.latestPoStatus]}</Chip>}
              </td>
              <td className={TD}><Chip tone={PRODUCTION_TONE[r.productionStatus]}>{m.labels.productionStatus[r.productionStatus]}</Chip></td>
              <td className={cn(TD, 'num', overdue && 'font-medium text-status-red-fg')}>
                {r.dueDate === null ? <span className="text-muted-foreground">{m.common.dash}</span>
                  : overdue ? `${fmt.date(r.dueDate)} · ${m.orders.overdue}`
                  : r.dueDate === today ? m.common.today : fmt.date(r.dueDate)}
              </td>
              <td className={cn(TD, 'num text-right whitespace-normal!', r.quote?.status !== 'accepted' && 'text-muted-foreground')}>
                {r.quote === null ? m.common.dash
                  : r.quote.status === 'accepted' ? fmt.money(r.quote.totalCents)
                  : m.orders.quoteTotal(fmt.money(r.quote.totalCents), m.labels.quoteStatus[r.quote.status])}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
    </>
  )
}

function InquiriesTable({ rows }: { rows: InquiryListRow[] }) {
  const { m, fmt } = useI18n()
  const c = m.orders.inquiryCols
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead><tr className="bg-header">
        <th className={TH}>{c.id}</th><th className={TH}>{c.name}</th><th className={TH}>{c.email}</th><th className={TH}>{c.phone}</th><th className={TH}>{c.received}</th>
      </tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className={`${TD} num font-medium`}>#{r.id}</td>
            <td className={TD}>{r.contactName ?? m.common.dash}</td>
            <td className={TD}>{r.contactEmail ?? m.common.dash}</td>
            <td className={`${TD} num`}>{r.contactPhone ?? m.common.dash}</td>
            <td className={`${TD} num`}>{fmt.date(r.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function OrderList() {
  const { m } = useI18n()
  const [params, setParams] = useSearchParams()
  const view: OrderView = isView(params.get('view')) ? (params.get('view') as OrderView) : 'active'
  const q = params.get('q') ?? ''
  const [text, setText] = useState(q)
  const query = useOrders(view, q)

  // The URL is the source of truth (reload and back keep view and q); typing is debounced into it.
  useEffect(() => { setText(q) }, [q])
  useEffect(() => {
    const t = setTimeout(() => {
      if (text.trim() === q) return
      setParams((p) => {
        const next = new URLSearchParams(p)
        if (text.trim()) next.set('q', text.trim())
        else next.delete('q')
        return next
      }, { replace: true })
    }, 250)
    return () => clearTimeout(t)
  }, [text, q, setParams])

  // The views are filters kept in the URL, so they are links (with the current search kept), not tabs.
  const viewHref = (v: OrderView) => {
    const next = new URLSearchParams(params)
    if (v === 'active') next.delete('view')
    else next.set('view', v)
    const s = next.toString()
    return s ? `?${s}` : '.'
  }

  const counts = query.data?.counts
  return (
    <div className={cn(PAGE, 'max-w-none gap-3 pt-4')}>
      <h1 className="text-xl font-semibold tracking-[-0.015em]">{m.orders.title}</h1>
      <nav aria-label={m.orders.views} className="flex flex-wrap gap-1">
        {ORDER_VIEWS.map((v) => (
          <Link
            key={v} to={viewHref(v)} aria-current={view === v ? 'page' : undefined}
            className={cn(
              'inline-flex h-[30px] items-center gap-1.5 rounded-[7px] px-2.5 text-[13px] font-medium no-underline',
              view === v ? 'bg-card text-foreground shadow-[0_0_0_1px_#E4E1DB,0_1px_2px_rgba(28,27,25,.05)]' : 'text-[#55524B] hover:bg-secondary',
            )}
          >
            {m.orders.view[v]}
            {counts && v !== 'completed' && <span className="num text-xs text-[#7A766E]">{counts[v]}</span>}
          </Link>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-[30px] flex-[0_1_300px] items-center gap-2 rounded-[7px] border border-input bg-card px-2.5 text-[13px] text-muted-foreground focus-within:ring-2 focus-within:ring-ring/40">
          <Search className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
          <input
            type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={m.orders.filterPlaceholder} aria-label={m.orders.filter}
            className="min-w-0 flex-1 border-0 bg-transparent text-foreground outline-none"
          />
        </label>
        <div className="grow" />
        <span className={MUTED}>{m.orders.sortedByDue}</span>
      </div>
      <QueryBoundary query={query}>
        {(d) => (
          <>
            <section className={`${CARD} overflow-x-auto`}>
              {d.rows.length === 0 ? (
                <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">{q ? m.orders.emptyFiltered : m.orders.empty}</p>
              ) : d.view === 'inquiries' ? <InquiriesTable rows={d.rows} /> : <OrdersTable rows={d.rows} />}
            </section>
            <span className={MUTED}>{m.orders.showing(d.rows.length)}</span>
          </>
        )}
      </QueryBoundary>
    </div>
  )
}
