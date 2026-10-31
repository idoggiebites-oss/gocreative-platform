// Request/response types for /api/app order screens. Dates are returned as stored
// (due_date YYYY-MM-DD, timestamps ISO UTC text); money is integer cents.
import type { ArtworkStatus, CustomerKind, EstimateStatus, Method, OrderSource, OrderState, PoStatus, ProductionStatus } from './enums'

export const ORDER_VIEWS = ['active', 'inquiries', 'waiting_po', 'waiting_artwork', 'in_production', 'ready', 'completed'] as const
export type OrderView = (typeof ORDER_VIEWS)[number]

export type AttentionReason = 'overdue' | 'artwork_changes_requested' | 'po_waiting' | 'new_inquiry' | 'ready_waiting' | 'quote_waiting'

export type DashboardMetrics = {
  activeOrders: number
  /** Active orders created in the last 7 days (a sibling of activeOrders, which stays a plain number). */
  activeOrdersNewThisWeek: number
  pendingQuotes: number
  /** Pending quotes whose latest estimate is 'sent' and was created more than 5 days ago. */
  pendingQuotesWaitingOver5Days: number
  artworkAwaitingApproval: { pending: number; changesRequested: number }
  posAwaitingApproval: { count: number; amountCents: number }
  inProduction: { count: number; qc: number }
  dueIn7Days: { count: number; overdue: number }
  readyForPickup: { count: number; oldestDaysWaiting?: number }
}
export type NeedsAttentionRow = {
  /** null for a new inquiry, which has no order yet (inquiryId is set instead). */
  number: string | null
  inquiryId: number | null
  customerName: string
  title: string
  itemsSummary: string
  reason: AttentionReason
  reasonDays?: number
  dueDate: string | null
}
export type DashboardResponse = {
  metrics: DashboardMetrics
  needsAttention: NeedsAttentionRow[]
  dueThisWeek: { number: string; customerName: string; dueDate: string; productionStatus: ProductionStatus }[]
  recentActivity: { actor: string; action: string; entityType: string; entityId: number; orderNumber: string | null; createdAt: string }[]
}

export type OrderListRow = {
  number: string
  customerName: string
  customerKind: CustomerKind
  title: string
  methods: Method[]
  totalQty: number
  artworkStatus: ArtworkStatus
  poRequired: boolean
  latestPoStatus: PoStatus | null
  productionStatus: ProductionStatus
  state: OrderState
  dueDate: string | null
  estimatedTotalCents: number | null
}
export type InquiryListRow = { id: number; contactName: string | null; contactEmail: string | null; contactPhone: string | null; createdAt: string }
export type OrderCounts = Record<OrderView, number>
export type OrdersListResponse =
  | { view: 'inquiries'; rows: InquiryListRow[]; counts: OrderCounts }
  | { view: Exclude<OrderView, 'inquiries'>; rows: OrderListRow[]; counts: OrderCounts }

export type GateResult = { ok: true } | { ok: false; reasons: string[] }
export type OrderDetailResponse = {
  order: {
    id: number
    number: string
    source: OrderSource
    title: string
    dueDate: string | null
    artworkStatus: ArtworkStatus
    poRequired: boolean
    authorizedAt: string | null
    authorizedBy: number | null
    productionStatus: ProductionStatus
    assigneeId: number | null
    estimatedTotalCents: number | null
    invoiceRef: string | null
    paymentRef: string | null
    state: OrderState
    createdAt: string
    updatedAt: string
  }
  customer: { id: number; name: string; kind: CustomerKind; email: string | null; phone: string | null }
  contact: { id: number; name: string; email: string | null; phone: string | null; title: string | null } | null
  items: {
    id: number
    product: string
    garmentColor: string | null
    method: Method
    sizes: Record<string, number> | null
    quantity: number
    unitPriceCents: number
    notes: string | null
  }[]
  latestEstimate: { id: number; version: number; inputs: unknown; lines: unknown; totalCents: number; status: EstimateStatus; createdAt: string } | null
  purchaseOrders: { id: number; poNumber: string | null; amountCents: number | null; status: PoStatus; createdAt: string; updatedAt: string }[]
  notes: { id: number; body: string; authorName: string | null; createdAt: string }[]
  activity: { id: number; actor: string; action: string; before: unknown; after: unknown; createdAt: string }[]
  gate: GateResult
}

export type ProductionChangeRequest = { to: ProductionStatus }
export type ProductionChangeResponse = { number: string; productionStatus: ProductionStatus; state: OrderState }
export type PoChangeRequest = { to: PoStatus }
export type PoChangeResponse = { poId: number; status: PoStatus; productionStatus: ProductionStatus }
// `error` is English text for logs; the UI shows a translation of `code` (and of each gate reason code in `reasons`).
export const API_ERROR_CODES = ['transition_not_allowed', 'gate_failed', 'conflict_retry', 'po_transition_not_allowed', 'not_found', 'invalid_request'] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]
export type ApiError = { error: string; code?: ApiErrorCode; reasons?: string[] }

// Codes the UI translates. Unknown codes fall back to a generic label, so the API can add one first.
export const ACTIVITY_ACTIONS = ['created', 'production_status_changed', 'po_status_changed'] as const
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number]
export const GATE_REASON_CODES = ['order_not_active', 'artwork_not_approved', 'po_missing', 'po_not_approved', 'not_authorized'] as const
export type GateReasonCode = (typeof GATE_REASON_CODES)[number]
