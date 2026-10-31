// Every status vocabulary in one place. The migrations' CHECK constraints, the
// zod schemas and the UI labels all derive from these, so adding a value is a
// change here plus a migration — never a string typed somewhere else.

export const ROLES = ['owner', 'staff'] as const
export const CUSTOMER_KINDS = ['district', 'organization', 'individual'] as const
export const ORDER_SOURCES = ['phone', 'email', 'portal'] as const
// Closed = fulfilled AND paid (PHASE2_PLAN §4.2); no track writes another track's status.
export const ORDER_STATES = ['active', 'cancelled', 'closed'] as const
export const METHODS = ['screen', 'embroidery', 'dtg', 'laser_engrave', 'laser_cut', 'other'] as const
export const ITEM_KINDS = ['product', 'charge', 'discount'] as const
export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'superseded'] as const
// Per artwork version.
export const ARTWORK_APPROVAL = ['under_review', 'changes_requested', 'approved'] as const
// The order's artwork status: derived from its designs' current versions, never stored.
export const ORDER_ARTWORK_STATUSES = ['not_received', 'under_review', 'changes_requested', 'approved', 'not_required'] as const
export const AUTHORIZATION_METHODS = ['phone', 'email', 'in_person', 'signed_form', 'other'] as const
export const PO_STATUSES = ['requested', 'received', 'under_review', 'approved', 'rejected', 'correction_required'] as const
// awaiting_* and ready are derived from readiness (never picked by hand); production ends at production_complete.
export const PRODUCTION_STATUSES = [
  'awaiting_quote',
  'awaiting_authorization',
  'awaiting_artwork',
  'awaiting_materials',
  'awaiting_preparation',
  'ready',
  'in_production',
  'quality_control',
  'production_complete',
] as const
export const FULFILMENT_STATUSES = ['not_ready', 'ready_for_pickup', 'customer_notified', 'picked_up'] as const
export const FINANCIAL_STATUSES = ['unpaid', 'partially_paid', 'paid'] as const
export const PURCHASE_STORED_STATUSES = ['not_ordered', 'ordered', 'cancelled'] as const
export const PURCHASE_STATUSES = ['not_ordered', 'ordered', 'partially_received', 'received', 'cancelled'] as const
export const PREP_STATUSES = ['not_started', 'in_progress', 'ready', 'not_required'] as const
export const PAYMENT_TERMS = ['due_at_pickup', 'due_after_pickup'] as const
export const PAYMENT_METHODS = ['check', 'ach', 'cash', 'card', 'other'] as const
export const NOTIFICATION_METHODS = ['phone', 'email', 'text', 'in_person', 'other'] as const
export const CHECK_STATUSES = ['awaiting_payment', 'ready_for_collection', 'collected', 'deposited', 'cleared'] as const
// The Payments page's suggested next step for an order that still owes money (domain/payments.ts nextPaymentAction).
export const PAYMENT_NEXT_ACTIONS = ['collect_check', 'await_check', 'collect_at_pickup', 'record_payment', 'request_check'] as const
export const INQUIRY_STATUSES = ['new', 'converted', 'spam'] as const

export type Role = (typeof ROLES)[number]
export type CustomerKind = (typeof CUSTOMER_KINDS)[number]
export type OrderSource = (typeof ORDER_SOURCES)[number]
export type OrderState = (typeof ORDER_STATES)[number]
export type Method = (typeof METHODS)[number]
export type ItemKind = (typeof ITEM_KINDS)[number]
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]
export type ArtworkApproval = (typeof ARTWORK_APPROVAL)[number]
export type OrderArtworkStatus = (typeof ORDER_ARTWORK_STATUSES)[number]
export type AuthorizationMethod = (typeof AUTHORIZATION_METHODS)[number]
export type PoStatus = (typeof PO_STATUSES)[number]
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number]
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number]
export type FinancialStatus = (typeof FINANCIAL_STATUSES)[number]
export type PurchaseStoredStatus = (typeof PURCHASE_STORED_STATUSES)[number]
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number]
export type PrepStatus = (typeof PREP_STATUSES)[number]
export type PaymentTerms = (typeof PAYMENT_TERMS)[number]
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]
export type NotificationMethod = (typeof NOTIFICATION_METHODS)[number]
export type CheckStatus = (typeof CHECK_STATUSES)[number]
export type PaymentNextAction = (typeof PAYMENT_NEXT_ACTIONS)[number]
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number]
