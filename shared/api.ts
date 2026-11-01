// Request/response types for /api/app order screens. Dates are returned as stored
// (due_date YYYY-MM-DD, timestamps ISO UTC text); money is integer cents.
import type { InquiryStatus,
  ArtworkApproval, AuthorizationMethod, CheckStatus, CustomerKind, FinancialStatus, FulfilmentStatus, ItemKind, Method, NotificationMethod,
  OrderArtworkStatus, OrderSource, OrderState, PaymentMethod, PaymentNextAction, PaymentTerms, PoStatus, PrepStatus,
  ProductionStatus, PurchaseStatus, QuoteStatus,
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
/** An Action required row: an active, pre-production order (awaiting_* or ready), soonest due first. */
export type ActionRow = { number: string; customerName: string; title: string; dueDate: string | null }
export type ActionRequired = {
  /** No accepted current quote at the order's items revision (production status awaiting_quote). */
  quotes: (ActionRow & { quoteStatus: QuoteStatus | null })[]
  /** Artwork required and not received, or changes requested on a current version. */
  missingArtwork: (ActionRow & { artworkStatus: OrderArtworkStatus })[]
  /** A PO is required and the latest one is not approved (null: none yet). */
  pendingPos: (ActionRow & { poStatus: PoStatus | null })[]
  /** Purchasing needed and an ordered purchase not fully received. */
  materialsAwaiting: ActionRow[]
  /** Production complete, not picked up yet (any production stage before that is not a pickup action). */
  awaitingPickup: (ActionRow & { fulfilmentStatus: 'ready_for_pickup' | 'customer_notified' })[]
  /** Check collections ready_for_collection; dueDate is the order's. One row per check (an order can have two). */
  checksToCollect: (ActionRow & { checkId: number; expectedCents: number; availableOn: string | null })[]
}
export type DashboardResponse = {
  metrics: DashboardMetrics
  needsAttention: NeedsAttentionRow[]
  dueThisWeek: { number: string; customerName: string; dueDate: string; productionStatus: ProductionStatus }[]
  recentActivity: { actor: string; action: string; entityType: string; entityId: number; orderNumber: string | null; createdAt: string }[]
  /** Same shape and order as ProductionResponse.current (slot 1 first). */
  currentJobs: ProductionJob[]
  /** The first five of ProductionResponse.readyToStart. */
  upcoming: ProductionJob[]
  actionRequired: ActionRequired
  /** PaymentsPageResponse.outstanding summed: orders owing, the total owed (unknown agreed totals count 0), the oldest. */
  outstandingPayments: { count: number; totalCents: number; oldestDays?: number }
}

// ---- production (M4) ----
export type ProductionJob = {
  number: string
  customerName: string
  title: string
  productionStatus: ProductionStatus
  dueDate: string | null
  /** Send back as expectedVersion on production, units and other order writes. */
  version: number
  /** First product line (by entry order) and how many product lines there are. */
  product: { first: string | null; lines: number }
  totalQuantity: number
  methods: Method[]
  unitsCompleted: number
  notesCount: number
  latestNote: { body: string; createdAt: string } | null
  /** What readiness says the job would be without production: Pause sends this (the server re-checks it). */
  preProductionStatus: ProductionStatus
  /** When the latest production start was logged (null if never started). */
  startedAt: string | null
  /** Ready to start only: the manual position (null = never placed; sorts after placed orders, then by due date). */
  queuePosition: number | null
  /** In production only. */
  slot: 1 | 2 | null
  /** Slot 2 only: the owner who overrode and why. */
  override: { by: string; reason: string } | null
}
export type ProductionResponse = {
  /** In production, slot order. */
  current: ProductionJob[]
  /** Ready orders: queue_position (unplaced last), then due date (none last), then created. */
  readyToStart: ProductionJob[]
  /** Active orders in quality_control or production_complete, most recently changed first (at most 20). */
  completed: ProductionJob[]
}
/** PATCH /orders/:number/units. 0 ≤ unitsCompleted ≤ the order's total product quantity; in_production or quality_control only. */
export type UnitsRequest = { unitsCompleted: number; expectedVersion: number }
/**
 * POST /production/queue. `seen` is the Ready to start list as the page showed it, `orderNumbers` the full new order
 * (the same numbers). 409 conflict_retry when the queue no longer matches `seen` (someone reordered, or an order became
 * ready or left); nothing is written then. Reordering does not bump any order's version.
 */
export type QueueReorderRequest = { seen: string[]; orderNumbers: string[] }
export type QueueReorderResponse = { readyToStart: string[] }

// ---- pickup, payments and check collection (M5) ----
// Fulfilment (the pickup) and the financial track (payments vs the agreed total) are separate (decision 6). The agreed
// total is the highest-version ACCEPTED quote's total (null when none: never paid, never a credit). An order closes in
// the same write that makes it both picked up and paid, and a void that leaves a closed order unpaid makes it active.
/** Derived from the order's non-voided payments and the agreed total (domain/payments.ts balance()). */
export type Balance = { agreedCents: number | null; receivedCents: number; outstandingCents: number | null; creditCents: number; status: FinancialStatus }
export type PickupRecord = {
  fulfilmentStatus: FulfilmentStatus
  /** The day production completed (shop time); null before then. */
  readyOn: string | null
  notifiedOn: string | null
  notificationMethod: NotificationMethod | null
  pickedUpOn: string | null
  collectedByName: string | null
  /** The employee who recorded the pickup. */
  completedBy: string | null
  /** An owner released an unpaid pay-at-pickup order. */
  releaseOverride: { by: string; reason: string } | null
  notes: string | null
}
export type PickupResponse = {
  number: string
  /** Send back as expectedVersion. */
  version: number
  state: OrderState
  paymentTerms: PaymentTerms
  pickup: PickupRecord
  balance: Balance
  /** True when recording the pickup now would need an owner override (pay at pickup, money still owed): show the warning. */
  releaseNeedsOverride: boolean
}
/**
 * Production complete and not yet picked up only (409 pickup_not_ready / pickup_recorded). notifiedOn defaults to today
 * (shop time); notifying again replaces the previous notification. notes, when given, replace the pickup's notes.
 */
export type NotifyPickupRequest = { notifiedOn?: string; method: NotificationMethod; notes?: string | null; expectedVersion: number }
/**
 * Records the pickup (one per order, final). Pay-at-pickup orders with money owed are 409 payment_required unless an owner
 * sends override + reason (staff: 403 override_requires_owner; blank reason: 400 override_requires_reason); the database
 * writes the pickup_release_override audit row. Pay-after-pickup orders (districts) can be picked up unpaid.
 */
export type CollectPickupRequest = {
  pickedUpOn?: string; collectedByName: string; notes?: string | null; override?: boolean; reason?: string; expectedVersion: number
}
export type PaymentRecord = {
  id: number; amountCents: number; method: PaymentMethod; paidOn: string; notes: string | null; recordedBy: string | null
  /** Set when the payment came from collecting a check. */
  checkCollectionId: number | null
  createdAt: string
  /** A voided payment stays listed and no longer counts. */
  voided: { at: string; by: string | null; reason: string } | null
}
export type CheckRecord = {
  id: number; orderNumber: string; expectedCents: number; amountReceivedCents: number | null; checkNumber: string | null; status: CheckStatus
  availableOn: string | null; collectedAt: string | null; collectedBy: string | null; depositedOn: string | null; clearedOn: string | null
  notes: string | null; createdAt: string
  /** The payment the collection recorded (null before collection). */
  paymentId: number | null
}
export type PaymentsResponse = {
  number: string; version: number; state: OrderState; paymentTerms: PaymentTerms; paymentDueOn: string | null
  /** Oldest first, voided ones included. */
  payments: PaymentRecord[]
  /** Oldest first. */
  checks: CheckRecord[]
  balance: Balance
}
/**
 * requestId: generated once per form submission (crypto.randomUUID) and reused when that submission is retried. A retry
 * with the same payload answers 200 with the stored payment (replayed: true); a different payload under the same
 * requestId is 409 request_id_conflict. paidOn defaults to today (shop time). Not on cancelled orders.
 */
export type RecordPaymentRequest = { amountCents: number; method: PaymentMethod; paidOn?: string; notes?: string | null; requestId: string; expectedVersion: number }
export type RecordPaymentResponse = OrderWriteResponse & { payment: PaymentRecord; replayed: boolean }
/** Owner only (403 void_requires_owner). The row stays, stops counting, and can't be un-voided (409 payment_voided). */
export type VoidPaymentRequest = { reason: string; expectedVersion: number }
/** Pay-after-pickup orders only (409 check_not_allowed). Starts as awaiting_payment; availableOn is when the district expects it. */
export type CheckCreateRequest = { expectedCents: number; availableOn?: string | null; checkNumber?: string | null; notes?: string | null; expectedVersion: number }
// The check moves (ready, collect, deposit, clear) are guarded by the check's own status, not the order version: each
// applies only from its one previous status (409 invalid_check_transition otherwise) and bumps the order's version.
/** availableOn defaults to today. */
export type CheckReadyRequest = { availableOn?: string }
/**
 * Records the payment (method check) in the same write. Retrying with the same amount (and check number, if sent)
 * answers 200 with the stored check and records nothing more; a different amount is 409 check_collect_conflict.
 */
export type CheckCollectRequest = { amountReceivedCents: number; checkNumber?: string | null; collectedOn?: string }
/** Deposited and cleared never touch payments or the balance. Dates default to today. */
export type CheckDepositRequest = { depositedOn?: string }
export type CheckClearRequest = { clearedOn?: string }
export type CheckWriteResponse = OrderWriteResponse & { check: CheckRecord }
/** An active order whose production is complete and that still owes money. */
export type OutstandingRow = {
  number: string; customerName: string; customerKind: CustomerKind; title: string; paymentTerms: PaymentTerms
  fulfilmentStatus: FulfilmentStatus; financialStatus: FinancialStatus
  agreedCents: number | null; receivedCents: number; outstandingCents: number | null
  /** orders.payment_due_on, when someone set it. */
  paymentDueOn: string | null
  /** From the pickup (pay after pickup; null until picked up) or from ready (pay at pickup). */
  daysOutstanding: number | null
  /** The order's most recent check collection's status, if any. */
  collectionStatus: CheckStatus | null
  nextAction: PaymentNextAction
  version: number
}
export type PaymentsPageResponse = {
  /** Most days outstanding first. */
  outstanding: OutstandingRow[]
  /** ready_for_collection, longest available first. */
  checksToCollect: (CheckRecord & { customerName: string })[]
  /** awaiting_payment: the district hasn't issued them yet. */
  checksAwaitingPayment: (CheckRecord & { customerName: string })[]
  /** collected or deposited, not yet confirmed cleared. */
  checksInHand: (CheckRecord & { customerName: string })[]
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
export type InquiryListRow = { id: number; ref: string | null; status: InquiryStatus; organization: string | null; contactName: string | null; contactEmail: string | null; contactPhone: string | null; createdAt: string }
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
    /** Set by hand when a payment date is agreed (YYYY-MM-DD). */
    paymentDueOn: string | null
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
  /** Newest first, each with its documents (newest first). */
  purchaseOrders: PurchaseOrderRecord[]
  /** The order's designs, each with every version newest first (versions[0] is the current one). */
  designs: ArtworkDesign[]
  notes: { id: number; body: string; authorName: string | null; createdAt: string }[]
  activity: { id: number; actor: string; action: string; before: unknown; after: unknown; createdAt: string }[]
  /** ok = readiness.ready; reasons = 'order_not_active' and/or '<item>.<reason>' for each pending item (GATE_REASON_CODES). */
  gate: GateResult
  readiness: ReadinessResult
}

/**
 * The one production write (PATCH /orders/:number/production). A start (ready → in_production, or a restart from
 * quality_control) takes slot 1; while slot 1 is busy it is 409 production_busy (runningJob names that order) unless an
 * active owner sends override + reason for slot 2 (staff: 403 override_requires_owner; blank reason: 400
 * override_requires_reason). With both slots taken it is 409 no_slot_available. override is ignored when slot 1 is free.
 */
export type ProductionChangeRequest = { to: ProductionStatus; expectedVersion: number; override?: boolean; reason?: string }
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
  poRequired?: boolean; paymentTerms?: PaymentTerms; paymentDueOn?: string | null; artworkRequired?: boolean
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

// ---- artwork, files and PO documents (M2a) ----
/**
 * Uploads are the raw file as the request body (not multipart): Content-Type = the file's type, X-Filename =
 * encodeURIComponent(file.name), and the other fields as query parameters (see ArtworkUploadQuery). At most 50 MB.
 * Content-Length is required (411 length_required without it; a File or Blob body always sends it) and the body
 * must be exactly that long (400 otherwise). The server sniffs the type from the first 4 KB; the declared
 * Content-Type must match it. An SVG must reach its <svg> element within those 4 KB.
 */
export type UploadedFile = { id: number; filename: string | null; mime: string; bytes: number; uploadedBy: string | null; uploadedAt: string }
export type ArtworkVersion = {
  id: number
  version: number
  approvalStatus: ArtworkApproval
  approvedAt: string | null
  approvedVia: AuthorizationMethod | null
  approvalRecordedBy: string | null
  /** Internal approval notes; never copied into the activity log. */
  notes: string | null
  createdAt: string
  /** Download at /api/app/files/:id (add ?download=1 to force a download). */
  file: UploadedFile
}
export type ArtworkDesign = { lineageId: number; name: string | null; orderNumber: string; versions: ArtworkVersion[] }
/** Query of POST /orders/:number/artwork: omit lineageId for a new design, or pass it for a new version of that design. */
export type ArtworkUploadQuery = { expectedVersion: number; designName?: string; lineageId?: number }
export type ArtworkDecisionRequest = { to: 'approved' | 'changes_requested'; via?: AuthorizationMethod; note?: string | null; expectedVersion: number }
export type ArtworkListResponse = { designs: ArtworkDesign[] }
/** The written order's state plus the new row's id (artworkId / poId / documentId). */
export type UploadResponse = OrderWriteResponse & { id: number }
export type PurchaseOrderRecord = {
  id: number; poNumber: string | null; amountCents: number | null; status: PoStatus; createdAt: string; updatedAt: string
  documents: { id: number; file: UploadedFile }[]
}
/**
 * While the order's latest PO is approved, a new one is refused (409 po_approved_exists) unless replaceApproved is
 * true and reason is non-blank: then it is created, logged as po_replaced, and authorization is pending again.
 */
export type PurchaseOrderCreateRequest = { poNumber?: string | null; amountCents?: number | null; replaceApproved?: boolean; reason?: string | null; expectedVersion: number }
/** An approved PO's number and amount are locked (409 po_approved_locked). */
export type PurchaseOrderDetailsRequest = { poNumber?: string | null; amountCents?: number | null; expectedVersion: number }
export type PurchaseOrdersResponse = { purchaseOrders: PurchaseOrderRecord[] }

// ---- purchasing and preparation (M3) ----
// Every purchase, receipt and prep write takes the order's expectedVersion and answers with OrderWriteResponse
// (creates: UploadResponse, i.e. plus the new row's id), like every other order write. Business dates are YYYY-MM-DD.
export type Supplier = { id: number; name: string; isDefault: boolean }
export type SuppliersResponse = { suppliers: Supplier[] }
/** 409 supplier_exists when the name is taken (case-insensitive). */
export type SupplierCreateRequest = { name: string }
export type SupplierResponse = { supplier: Supplier }
export type PurchaseReceipt = {
  id: number; quantity: number; sizes: Record<string, number> | null; receivedOn: string; notes: string | null; recordedBy: string | null; createdAt: string
}
export type PurchaseRecord = {
  id: number; supplierId: number; supplierName: string; description: string; quantity: number; sizes: Record<string, number> | null
  estimatedUnitCostCents: number | null; actualUnitCostCents: number | null
  /** quantity × unit cost; null while the unit cost is unknown. Supplier cost, never the customer's price. */
  estimatedTotalCents: number | null; actualTotalCents: number | null
  /** Derived from the stored status and the receipts. */
  status: PurchaseStatus; receivedQuantity: number; overReceived: boolean
  orderedOn: string | null; expectedOn: string | null; notes: string | null; createdBy: string | null; createdAt: string; updatedAt: string
  receipts: PurchaseReceipt[]
}
export type PurchasesResponse = { purchases: PurchaseRecord[] }
/** Created as not_ordered. supplierId omitted = the default supplier. sizes, when given, must add up to quantity. */
export type PurchaseCreateRequest = {
  supplierId?: number; description: string; quantity: number; sizes?: Record<string, number> | null
  estimatedUnitCostCents?: number | null; expectedOn?: string | null; notes?: string | null; expectedVersion: number
}
/**
 * A field left out keeps its value; null clears it. Not ordered: every field. Ordered: only actualUnitCostCents,
 * expectedOn and notes. Cancelled: nothing. Anything else is 409 purchase_locked.
 */
export type PurchasePatchRequest = Partial<Omit<PurchaseCreateRequest, 'expectedVersion'>> & { actualUnitCostCents?: number | null; expectedVersion: number }
/** Staff confirm the purchase was made (the app never buys). orderedOn defaults to today in shop time. */
export type PurchaseOrderedRequest = { orderedOn?: string; expectedVersion: number }
/** Only an ordered purchase takes a receipt (409 purchase_not_ordered). Over-receiving is allowed. receivedOn defaults to today. */
export type ReceiptCreateRequest = { quantity: number; sizes?: Record<string, number> | null; receivedOn?: string; notes?: string | null; expectedVersion: number }
export type PrepRequest = { prepStatus: PrepStatus; expectedVersion: number }

// `error` is English text for logs; the UI shows a translation of `code` (and of each gate reason code in `reasons`).
export const API_ERROR_CODES = [
  'pricing_invalid', 'pricing_changed',
  'inquiry_not_new', 'inquiry_not_convertible',
  'transition_not_allowed', 'gate_failed', 'conflict_retry', 'po_transition_not_allowed', 'not_found', 'invalid_request',
  'contact_archived', 'contact_not_for_customer', 'confirmation_required', 'order_not_active', 'production_started', 'quote_stale',
  'quote_frozen', 'quote_not_draft', 'invalid_quote_transition', 'no_product_line', 'discount_exceeds_total', 'po_required',
  'not_authorized', 'file_too_large', 'unsupported_file_type', 'file_type_mismatch', 'not_current_version', 'artwork_unchanged',
  'po_not_required', 'length_required', 'po_approved_locked', 'po_approved_exists',
  'supplier_exists', 'purchase_locked', 'purchase_transition_not_allowed', 'purchase_not_ordered',
  'production_busy', 'no_slot_available', 'override_requires_owner', 'override_requires_reason', 'invalid_units_completed', 'units_not_editable',
  'pickup_not_ready', 'pickup_recorded', 'payment_required', 'request_id_conflict', 'payment_voided', 'void_requires_owner',
  'check_not_allowed', 'invalid_check_transition', 'check_collect_conflict',
  'payment_terms_owner_only', 'payment_terms_locked', 'cross_site_request', 'body_too_large',
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]
export type ApiError = { error: string; code?: ApiErrorCode; reasons?: string[]; /** production_busy: the order running in slot 1. */ runningJob?: string }

// Codes the UI translates. Unknown codes fall back to a generic label, so the API can add one first.
export const ACTIVITY_ACTIONS = [
  'created', 'production_status_changed', 'po_status_changed', 'customer_created', 'customer_updated', 'contact_added',
  'contact_updated', 'contact_archived', 'contact_unarchived', 'note_added', 'order_updated', 'no_purchasing_confirmed',
  'items_replaced', 'quote_created', 'quote_refreshed', 'quote_status_changed', 'order_repeated', 'authorization_recorded',
  'authorization_revoked', 'order_cancelled', 'order_reopened', 'artwork_uploaded', 'artwork_decided', 'po_created',
  'po_details_updated', 'po_document_added', 'po_replaced',
  'supplier_created', 'purchase_created', 'purchase_updated', 'purchase_ordered', 'purchase_cancelled', 'purchase_received', 'prep_status_changed',
  'production_started', 'production_override', 'units_completed_changed', 'queue_reordered',
  'pickup_notified', 'pickup_collected', 'pickup_release_override', 'payment_recorded', 'payment_voided',
  'check_created', 'check_ready', 'check_collected', 'check_deposited', 'check_cleared', 'order_closed',
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
  /** Concurrency guard: PATCH / archive / unarchive must send the version they saw. */
  version: number
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
/** PATCH contact sends `ContactRequest & { expectedVersion }`; archive / unarchive send `{ expectedVersion }`. */
export type ContactPatchRequest = Partial<Omit<ContactRequest, 'isPrimary'>> & { isPrimary?: boolean; expectedVersion: number }
export type ContactResponse = { contact: CustomerContact }
export type NoteResponse = { note: CustomerNote }

export type InquiryDetailResponse = {
  id: number; ref: string | null; status: InquiryStatus; version: number; receivedAt: string
  customerKind: CustomerKind | null; organization: string | null
  contactName: string | null; contactEmail: string | null; contactPhone: string | null; preferredContact: string | null
  /** What the customer asked for. A request, never a commitment. */
  dueDate: string | null
  declineReason: string | null; convertedAt: string | null; orderNumber: string | null
  lines: { product: string; method: string; quantity: number; sizes: Record<string, number> | null; color: string | null; material: string | null; personalization: string | null; notes: string | null }[]
  description: string | null; designHelp: boolean; convertible: boolean
  files: { id: number; kind: 'artwork' | 'po'; filename: string | null; mime: string; bytes: number }[]
  matches: { id: number; name: string; kind: CustomerKind; contacts: { id: number; name: string; email: string | null; phone: string | null }[] }[]
}
export type InquiryConvertRequest = {
  expectedVersion: number; title: string; dueDate: string | null; artworkRequired: boolean
  customer: { existingId: number; contactId: number | null } | { new: { name: string; kind: CustomerKind; organization: string | null } }
}
export type InquiryConvertResponse = { number: string; alreadyConverted: boolean }
