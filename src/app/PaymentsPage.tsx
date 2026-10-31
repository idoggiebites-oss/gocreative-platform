import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { CheckRecord, OutstandingRow } from '@shared/api'
import { useI18n } from '@/i18n'
import { usePaymentsPage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CheckActions } from './CheckActions'
import { BTN, BTN_SM, H2, SEC } from './form'
import { RecordPaymentDialog } from './PaymentsTab'
import QueryBoundary from './QueryBoundary'
import { CARD, CHECK_TONE, Chip, FINANCIAL_TONE, MUTED, PAGE, TD, TH } from './ui'

const sm = cn(BTN, BTN_SM)
type CheckRow = CheckRecord & { customerName: string }

function Tiles({ outstanding, toCollect, inHand }: { outstanding: OutstandingRow[]; toCollect: CheckRow[]; inHand: CheckRow[] }) {
  const { m, fmt } = useI18n()
  const t = m.paymentsPage
  const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0)
  const cells: [string, string, string][] = [
    [t.tiles.outstanding, fmt.money(sum(outstanding.map((r) => r.outstandingCents ?? 0))), t.orderCount(outstanding.length)],
    [t.tiles.toCollect, fmt.money(sum(toCollect.map((k) => k.expectedCents))), t.checkCount(toCollect.length)],
    [t.tiles.inHand, fmt.money(sum(inHand.map((k) => k.amountReceivedCents ?? k.expectedCents))), `${t.checkCount(inHand.length)} · ${t.inHandSub}`],
  ]
  return (
    <section aria-label={t.title} className={`${CARD} grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))]`}>
      {cells.map(([label, value, sub]) => (
        <div key={label} className="flex flex-col gap-1 border-r border-secondary px-4 py-3.5 last:border-r-0">
          <span className={MUTED}>{label}</span>
          <span className="num text-2xl font-semibold tracking-[-0.02em]">{value}</span>
          <span className={MUTED}>{sub}</span>
        </div>
      ))}
    </section>
  )
}

function Outstanding({ rows }: { rows: OutstandingRow[] }) {
  const { m, fmt } = useI18n()
  const t = m.paymentsPage
  const [paying, setPaying] = useState<string | null>(null)
  const money = (c: number | null) => (c === null ? m.common.dash : fmt.money(c))
  const canRecord = (r: OutstandingRow) => r.nextAction === 'record_payment' || r.nextAction === 'collect_at_pickup'
  const record = (r: OutstandingRow) => canRecord(r) && (
    <button type="button" className={sm} aria-label={`${m.pay.record}: ${r.number}`} onClick={() => setPaying(r.number)}>{m.pay.record}</button>
  )
  const total = rows.reduce((s, r) => s + (r.outstandingCents ?? 0), 0)
  return (
    <section aria-labelledby="out" className={CARD}>
      <div className={SEC}><h2 id="out" className={H2}>{t.outstandingTitle}</h2><span className={MUTED}>{t.outstandingSub}</span></div>
      {rows.length === 0 ? <p className="px-4 pb-4 text-[13px] text-muted-foreground">{t.outstandingEmpty}</p> : (
        <>
          <ul className="sm:hidden" aria-label={t.outstandingTitle}>
            {rows.map((r) => (
              <li key={r.number} className="flex flex-col gap-1.5 border-t border-secondary px-4 py-3 text-[13px]">
                <div className="flex min-w-0 items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate"><Link to={`/app/orders/${r.number}`} className="num font-medium text-foreground no-underline hover:text-primary hover:underline">{r.number}</Link> {r.customerName}</span>
                  <span className="num flex-none font-semibold">{money(r.outstandingCents)}</span>
                </div>
                <span className={MUTED}>{[m.labels.paymentTerms[r.paymentTerms], r.paymentDueOn ? m.production.due(fmt.date(r.paymentDueOn)) : null, r.daysOutstanding !== null ? t.daysOutLine(r.daysOutstanding) : null].filter(Boolean).join(' · ')}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={FINANCIAL_TONE[r.financialStatus]}>{m.labels.financialStatus[r.financialStatus]}</Chip>
                  {r.collectionStatus && <Chip tone={CHECK_TONE[r.collectionStatus]}>{m.labels.checkStatus[r.collectionStatus]}</Chip>}
                  <span>{m.labels.paymentNextAction[r.nextAction]}</span>
                </div>
                {record(r)}
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full border-collapse text-[13px]">
              <thead><tr>
                {[t.cols.customer, t.cols.order, t.cols.agreed, t.cols.received, t.cols.outstanding, t.cols.terms, t.cols.due, t.cols.daysOut, t.cols.collection, t.cols.next, t.cols.action].map((h) => <th key={h} className={TH}>{h}</th>)}
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.number} data-order={r.number}>
                    <td className={TD}>{r.customerName}</td>
                    <td className={`${TD} num font-medium`}><Link to={`/app/orders/${r.number}`} className="text-foreground no-underline hover:text-primary hover:underline">{r.number}</Link></td>
                    <td className={`${TD} num`}>{money(r.agreedCents)}</td>
                    <td className={`${TD} num`}>{fmt.money(r.receivedCents)}</td>
                    <td className={`${TD} num font-semibold`}>{money(r.outstandingCents)}</td>
                    <td className={TD}>{m.labels.paymentTerms[r.paymentTerms]}</td>
                    <td className={`${TD} num`}>{r.paymentDueOn ? fmt.date(r.paymentDueOn) : t.notSet}</td>
                    <td className={`${TD} num`}>{r.daysOutstanding ?? m.common.dash}</td>
                    <td className={TD}>{r.collectionStatus ? <Chip tone={CHECK_TONE[r.collectionStatus]}>{m.labels.checkStatus[r.collectionStatus]}</Chip> : <span className="text-muted-foreground">{t.noCollection}</span>}</td>
                    <td className={TD}>{m.labels.paymentNextAction[r.nextAction]}</td>
                    <td className={TD}>{record(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="num px-4 py-3 text-right text-[13px]"><span className="text-muted-foreground">{t.total}: </span><b className="font-semibold">{fmt.money(total)}</b></p>
        </>
      )}
      {paying && <RecordPaymentDialog number={paying} onClose={() => setPaying(null)} />}
    </section>
  )
}

function Checks({ id, title, rows, empty, children }: { id: string; title: string; rows: CheckRow[]; empty: string; children?: ReactNode }) {
  const { m, fmt } = useI18n()
  const t = m.paymentsPage
  return (
    <section aria-labelledby={id} className={CARD}>
      <div className={SEC}><h2 id={id} className={H2}>{title}</h2><Chip tone="gray">{t.checkCount(rows.length)}</Chip></div>
      {children}
      {rows.length === 0 ? <p className="px-4 pb-4 text-[13px] text-muted-foreground">{empty}</p> : (
        <ul aria-label={title}>
          {rows.map((k) => (
            <li key={k.id} data-check={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-secondary px-4 py-3 text-[13px]">
              <div className="flex min-w-0 flex-[1_1_220px] flex-col">
                <span className="flex flex-wrap items-baseline gap-x-2"><Link to={`/app/orders/${k.orderNumber}`} className="num font-medium text-foreground no-underline hover:text-primary hover:underline">{k.orderNumber}</Link><span>{k.customerName}</span></span>
                <span className={cn(MUTED, 'num')}>
                  {[m.checks.expectedLine(fmt.money(k.expectedCents)), k.checkNumber ? m.checks.number(k.checkNumber) : t.notIssued, k.availableOn ? m.checks.available(fmt.date(k.availableOn)) : m.checks.notAvailable].join(' · ')}
                </span>
              </div>
              <Chip tone={CHECK_TONE[k.status]}>{m.labels.checkStatus[k.status]}</Chip>
              <CheckActions check={k} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function PaymentsPage() {
  const { m } = useI18n()
  const query = usePaymentsPage()
  return (
    <QueryBoundary query={query}>
      {(d) => (
        <div className={PAGE}>
          <h1 className="text-xl font-semibold tracking-[-0.015em]">{m.paymentsPage.title}</h1>
          <Tiles outstanding={d.outstanding} toCollect={d.checksToCollect} inHand={d.checksInHand} />
          <Outstanding rows={d.outstanding} />
          <Checks id="ctc" title={m.paymentsPage.checksToCollect} rows={d.checksToCollect} empty={m.paymentsPage.checksToCollectEmpty} />
          <Checks id="caw" title={m.paymentsPage.awaiting} rows={d.checksAwaitingPayment} empty={m.paymentsPage.awaitingEmpty} />
          <Checks id="cih" title={m.paymentsPage.inHand} rows={d.checksInHand} empty={m.paymentsPage.inHandEmpty} />
        </div>
      )}
    </QueryBoundary>
  )
}
