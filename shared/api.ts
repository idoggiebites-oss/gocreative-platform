// Request/response types for /api/app order screens. Dates are returned as stored
// (due_date YYYY-MM-DD, timestamps ISO UTC text); money is integer cents.
import type {
  AuthorizationMethod, CustomerKind, ItemKind, Method, OrderArtworkStatus, OrderSource, OrderState, PaymentTerms, PoStatus, PrepStatus,
  ProductionStatus, QuoteStatus,
} from './enums'

export const ORDER_VIEWS = ['active', 'inquiries', 'waiting_po', 'waiting_artwork', 'in_production', 'ready', 'completed'] as const
export type OrderView = (typeof ORDER_VIEWS)[number]

export type AttentionReason = 'overdue' | 'artwork_changes_requested' | 'po_waiting' | 'new_inquiry' | 'ready_waiting' | 'quote_waiting'

export type DashboardMetrics = {
  activeOrders: number
  /** Active orders created in the last 7 days (a sibling of activeOrders, which stays a plain number). */
  activeOrdersNewThisWeek: number
  pendingQuotes: number
  /** Pending quotes whose current quote is 'sent' and was sent more than 5 days ago. */
  pendingQuotesWaitingOver5Days: number
  /** pending = current versions under review. */
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
  artworkStatus: OrderArtworkStatus
  poRequired: boolean
  latestPoStatus: PoStatus | null
  productionStatus: ProductionStatus
  state: OrderState
  dueDate: string | null
  /** The order's conflict-guard counter; send it back as expectedVersion. */
  version: number
  /** The current (highest-version) quote. Its total is the agreed total only when it is accepted. */
  quote: { status: QuoteStatus; totalCents: number } | null
}
export type InquiryListRow = { id: number; contactName: string | null; contactEmail: string | null; contactPhone: string | null; createdAt: string }
export type OrderCounts = Record<OrderView, number>
export type OrdersListResponse =
  | { view: 'inquiries'; rows: InquiryListRow[]; counts: OrderCounts }
  | { view: Exclude<OrderView, 'inquiries'>; rows: OrderListRow[]; counts: OrderCounts }

export type GateResult = { ok: true } | { ok: false; reasons: string[] }
export type ReadinessKey = 'quote' | 'authorization' | 'artwork' | 'materials' | 'preparation'
/** domain/readiness.ts's result: the five items in fixed order, whether production may start, and the derived awaiting status. */
export type ReadinessResult = {
  items: { key: ReadinessKey; state: 'complete' | 'pending' | 'not_required'; reason?: string }[]
  ready: boolean
  preProductionStatus: ProductionStatus
}
export type OrderItem = {
  id: number
  kind: ItemKind
  description: string | null
  /** null on charge and discount lines. */
  product: string | null
  garmentColor: string | null
  method: Method | null
  sizes: Record<string, number> | null
  quantity: number
  unitPriceCents: number
}
export type OrderDetailResponse = {
  order: {
    id: number
    number: string
    source: OrderSource
    title: string
    dueDate: string | null
    /** Derived from the designs' current versions. */
    artworkStatus: OrderArtworkStatus
    artworkRequired: boolean
    poRequired: boolean
    authorizedAt: string | null
    authorizedBy: number | null
    authorizationMethod: AuthorizationMethod | null
    authorizationNotes: string | null
    itemsRevision: number
    paymentTerms: PaymentTerms
    materialsRequired: boolean
    prepStatus: PrepStatus
    productionStatus: ProductionStatus
    assigneeId: number | null
    invoiceRef: string | null
    paymentRef: string | null
    state: OrderState
    /** Conflict guard: send it back as expectedVersion. updatedAt is for display only. */
    version: number
    createdAt: string
    updatedAt: string
  }
  customer: { id: number; name: string; kind: CustomerKind; email: string | null; phone: string | null }
  contact: { id: number; name: string; email: string | null; phone: string | null; title: string | null } | null
  items: (OrderItem & { notes: string | null })[]
  /** The current (highest-version) quote and its frozen lines; replaces Phase 1's latestEstimate. */
  quote: {
    id: number
    version: number
    status: QuoteStatus
    itemsRevision: number
    subtotalCents: number
    chargesCents: number
    discountsCents: number
    totalCents: number
    createdAt: string
    sentAt: string | null
    decidedAt: string | null
    items: (OrderItem & { lineTotalCents: number })[]
  } | null
  purchaseOrders: { id: number; poNumber: string | null; amountCents: number | null; status: PoStatus; createdAt: string; updatedAt: string }[]
  notes: { id: number; body: string; authorName: string | null; createdAt: string }[]
  activity: { id: number; actor: string; action: string; before: unknown; after: unknown; createdAt: string }[]
  /** ok = readiness.ready; reasons = 'order_not_active' and/or '<item>.<reason>' for each pending item (GATE_REASON_CODES). */
  gate: GateResult
  readiness: ReadinessResult
}

export type ProductionChangeRequest = { to: ProductionStatus; expectedVersion: number }
export type ProductionChangeResponse = { number: string; productionStatus: ProductionStatus; state: OrderState; version: number }
/** expectedVersion is the order's version; every applied PO change bumps it (the new one comes back as version). */
export type PoChangeRequest = { to: PoStatus; expectedVersion: number }
export type PoChangeResponse = { poId: number; status: PoStatus; productionStatus: ProductionStatus; version: number }
// ---- order writes (M1c) ----
export type ItemInput = {
  /** An existing item's id keeps its identity (and so its place in the reapproval comparison); omit for a new line. */
  id?: number
  kind: ItemKind
  description?: string | null
  product?: string | null
  garmentColor?: string | null
  method?: Method | null
  sizes?: Record<string, number> | null
  quantity: number
  unitPriceCents: number
  /** Internal; never bumps itemsRevision. */
  notes?: string | null
}
export type CreateOrderRequest = {
  customerId: number; contactId?: number | null; source: OrderSource; title: string; dueDate?: string | null
  poRequired?: boolean; paymentTerms?: PaymentTerms; artworkRequired?: boolean; items?: ItemInput[]
}
export type UpdateOrderRequest = {
  expectedVersion: number; title?: string; dueDate?: string | null; contactId?: number | null; source?: OrderSource
  poRequired?: boolean; paymentTerms?: PaymentTerms; artworkRequired?: boolean
  /** false = "No purchasing needed", which needs confirmNoPurchasing: true. */
  materialsRequired?: boolean; confirmNoPurchasing?: boolean; assigneeId?: number | null
}
export type ReplaceItemsRequest = { expectedVersion: number; items: ItemInput[] }
export type QuoteChangeRequest = { to: 'sent' | 'accepted' | 'declined'; expectedVersion: number }
export type AuthorizationRequest = { method: AuthorizationMethod; notes?: string | null; expectedVersion: number }
export type ReasonRequest = { reason: string; expectedVersion: number }
/** Body of new quote, refresh, duplicate and reopen. */
export type VersionedRequest = { expectedVersion: number }
/** Every order write answers with the order's state after the write (re-read from the database). */
export type OrderWriteResponse = {
  number: string; version: number; productionStatus: ProductionStatus; itemsRevision: number; state: OrderState
  quote?: { version: number; status: QuoteStatus }
}

// `error` is English text for logs; the UI shows a translation of `code` (and of each gate reason code in `reasons`).
export const API_ERROR_CODES = [
  'transition_not_allowed', 'gate_failed', 'conflict_retry', 'po_transition_not_allowed', 'not_found', 'invalid_request',
  'contact_archived', 'contact_not_for_customer', 'confirmation_required', 'order_not_active', 'production_started', 'quote_stale',
  'quote_frozen', 'quote_not_draft', 'invalid_quote_transition', 'no_product_line', 'discount_exceeds_total', 'po_required',
  'not_authorized',
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]
export type ApiError = { error: string; code?: ApiErrorCode; reasons?: string[] }

// Codes the UI translates. Unknown codes fall back to a generic label, so the API can add one first.
export const ACTIVITY_ACTIONS = [
  'created', 'production_status_changed', 'po_status_changed', 'customer_created', 'customer_updated', 'contact_added',
  'contact_updated', 'contact_archived', 'contact_unarchived', 'note_added', 'order_updated', 'no_purchasing_confirmed',
  'items_replaced', 'quote_created', 'quote_refreshed', 'quote_status_changed', 'order_repeated', 'authorization_recorded',
  'authorization_revoked', 'order_cancelled', 'order_reopened',
] as const
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number]
export const GATE_REASON_CODES = [
  'order_not_active',
  'quote.no_quote', 'quote.not_accepted', 'quote.items_changed_since_acceptance', 'quote.empty_quote',
  'authorization.po_missing', 'authorization.po_not_approved', 'authorization.not_authorized',
  'artwork.not_received', 'artwork.under_review', 'artwork.changes_requested',
  'materials.not_ordered', 'materials.awaiting_delivery',
  'preparation.not_started', 'preparation.in_progress',
] as const
export type GateReasonCode = (typeof GATE_REASON_CODES)[number]

// ---- customers (M1b) ----
export type CustomerListRow = {
  id: number
  name: string
  kind: CustomerKind
  organization: string | null
  email: string | null
  phone: string | null
  defaultPoRequired: boolean
  defaultPaymentTerms: PaymentTerms
  activeOrders: number
  /** null until M5 (payments) fills it. */
  outstanding: number | null
  lastOrderAt: string | null
}
export type CustomersListResponse = { rows: CustomerListRow[] }
export type CustomerContact = {
  id: number
  name: string
  email: string | null
  phone: string | null
  title: string | null
  isPrimary: boolean
  archived: boolean
  archivedAt: string | null
}
export type CustomerRecord = {
  id: number
  name: string
  kind: CustomerKind
  organization: string | null
  email: string | null
  phone: string | null
  defaultPoRequired: boolean
  defaultPaymentTerms: PaymentTerms
  internalNotes: string | null
  createdAt: string
  updatedAt: string
  /** Send back as expectedVersion when patching. */
  version: number
}
export type CustomerNote = { id: number; body: string; authorName: string | null; createdAt: string }
export type CustomerDetailResponse = {
  customer: CustomerRecord
  contacts: CustomerContact[]
  orders: { number: string; title: string; productionStatus: ProductionStatus; state: OrderState; quote: { status: QuoteStatus; totalCents: number } | null; createdAt: string }[]
  notes: CustomerNote[]
  activity: { id: number; actor: string; action: string; before: unknown; after: unknown; createdAt: string }[]
}
export type CustomerCreateRequest = {
  name: string
  kind: CustomerKind
  organization?: string | null
  email?: string | null
  phone?: string | null
  defaultPoRequired?: boolean
  defaultPaymentTerms?: PaymentTerms
  internalNotes?: string | null
}
export type CustomerPatchRequest = Partial<CustomerCreateRequest> & { expectedVersion: number }
export type CustomerResponse = { customer: CustomerRecord }
export type ContactRequest = { name: string; email?: string | null; phone?: string | null; title?: string | null; isPrimary?: boolean }
export type ContactResponse = { contact: CustomerContact }
export type NoteResponse = { note: CustomerNote }
