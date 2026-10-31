import type { ArtworkStatus, PoStatus, ProductionStatus } from '../../shared/enums.ts'
import type { AttentionReason, DashboardMetrics } from '../../shared/api.ts'

export type DashOrder = {
  id: number
  number: string
  customerName: string
  title: string
  artworkStatus: ArtworkStatus
  productionStatus: ProductionStatus
  dueDate: string | null
  latestPoStatus: PoStatus | null
  latestPoAmountCents: number | null
  latestEstimateStatus: string | null
  createdAt: string
  latestEstimateCreatedAt: string | null
}
export type DashInquiry = { id: number; contactName: string | null }
export type AttentionCandidate = {
  orderId: number | null
  inquiryId: number | null
  number: string | null
  customerName: string
  title: string
  reason: AttentionReason
  reasonDays?: number
  dueDate: string | null
}

// Most severe first; an order is listed once, under its most severe reason.
const SEVERITY: AttentionReason[] = ['overdue', 'artwork_changes_requested', 'po_waiting', 'new_inquiry', 'ready_waiting', 'quote_waiting']

const DAY = 86_400_000
const dayNumber = (date: string) => Date.parse(date.slice(0, 10)) / DAY
export const addDays = (date: string, n: number) => new Date(dayNumber(date) * DAY + n * DAY).toISOString().slice(0, 10)
const PO_WAITING = ['received', 'under_review']

/** Pure: takes ACTIVE orders, when each ready-for-pickup order entered that state, new inquiries, and today (YYYY-MM-DD). */
export function buildDashboard(orders: DashOrder[], readyAt: Map<number, string>, inquiries: DashInquiry[], today: string) {
  const weekEnd = addDays(today, 7)
  const notDone = orders.filter((o) => o.productionStatus !== 'completed')
  const overdue = (o: DashOrder) => o.dueDate !== null && o.dueDate < today
  const waitingPo = orders.filter((o) => o.latestPoStatus !== null && PO_WAITING.includes(o.latestPoStatus))
  const ready = orders.filter((o) => o.productionStatus === 'ready_for_pickup')
  const readyDays = (o: DashOrder) => {
    const at = readyAt.get(o.id)
    return at === undefined ? undefined : Math.max(0, dayNumber(today) - dayNumber(at))
  }
  const oldest = ready.map(readyDays).filter((d): d is number => d !== undefined)

  const metrics: DashboardMetrics = {
    activeOrders: orders.length,
    activeOrdersNewThisWeek: orders.filter((o) => o.createdAt.slice(0, 10) >= addDays(today, -7)).length,
    pendingQuotes: orders.filter((o) => o.latestEstimateStatus === 'draft' || o.latestEstimateStatus === 'sent').length,
    pendingQuotesWaitingOver5Days: orders.filter(
      (o) => o.latestEstimateStatus === 'sent' && o.latestEstimateCreatedAt !== null && o.latestEstimateCreatedAt.slice(0, 10) < addDays(today, -5),
    ).length,
    artworkAwaitingApproval: {
      pending: orders.filter((o) => o.artworkStatus === 'pending').length,
      changesRequested: orders.filter((o) => o.artworkStatus === 'changes_requested').length,
    },
    posAwaitingApproval: { count: waitingPo.length, amountCents: waitingPo.reduce((s, o) => s + (o.latestPoAmountCents ?? 0), 0) },
    inProduction: {
      count: orders.filter((o) => o.productionStatus === 'in_production' || o.productionStatus === 'quality_control').length,
      qc: orders.filter((o) => o.productionStatus === 'quality_control').length,
    },
    dueIn7Days: {
      count: notDone.filter((o) => o.dueDate !== null && o.dueDate >= today && o.dueDate < weekEnd).length,
      overdue: notDone.filter(overdue).length,
    },
    readyForPickup: { count: ready.length, ...(oldest.length ? { oldestDaysWaiting: Math.max(...oldest) } : {}) },
  }

  const candidates: AttentionCandidate[] = []
  for (const o of orders) {
    let reason: AttentionReason | null = null
    let reasonDays: number | undefined
    if (o.productionStatus !== 'completed' && overdue(o)) {
      reason = 'overdue'
      reasonDays = dayNumber(today) - dayNumber(o.dueDate as string)
    } else if (o.artworkStatus === 'changes_requested') reason = 'artwork_changes_requested'
    else if (o.latestPoStatus !== null && PO_WAITING.includes(o.latestPoStatus)) reason = 'po_waiting'
    else if (o.productionStatus === 'ready_for_pickup') {
      reason = 'ready_waiting'
      reasonDays = readyDays(o)
    } else if (o.latestEstimateStatus === 'sent') reason = 'quote_waiting'
    if (reason) {
      candidates.push({ orderId: o.id, inquiryId: null, number: o.number, customerName: o.customerName, title: o.title, reason, ...(reasonDays === undefined ? {} : { reasonDays }), dueDate: o.dueDate })
    }
  }
  for (const i of inquiries) {
    candidates.push({ orderId: null, inquiryId: i.id, number: null, customerName: i.contactName ?? '', title: '', reason: 'new_inquiry', dueDate: null })
  }
  candidates.sort(
    (a, b) => SEVERITY.indexOf(a.reason) - SEVERITY.indexOf(b.reason) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'),
  )

  const dueThisWeek = orders
    .filter((o) => o.dueDate !== null && o.dueDate >= today && o.dueDate < weekEnd)
    .sort((a, b) => (a.dueDate as string).localeCompare(b.dueDate as string) || a.number.localeCompare(b.number))
    .map((o) => ({ number: o.number, customerName: o.customerName, dueDate: o.dueDate as string, productionStatus: o.productionStatus }))

  return { metrics, attention: candidates.slice(0, 10), dueThisWeek }
}
