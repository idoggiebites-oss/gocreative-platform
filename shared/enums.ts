// Every status vocabulary in one place. The migration's CHECK constraints, the
// zod schemas and the UI labels all derive from these, so adding a value is a
// change here plus a migration — never a string typed somewhere else.

export const ROLES = ['owner', 'staff'] as const
export const CUSTOMER_KINDS = ['district', 'organization', 'individual'] as const
export const ORDER_SOURCES = ['phone', 'email', 'portal'] as const
export const ORDER_STATES = ['active', 'completed', 'cancelled'] as const
export const METHODS = ['screen', 'embroidery', 'dtg', 'laser_engrave', 'laser_cut', 'other'] as const

// Order-level summary of its artwork; 'none' = nothing uploaded yet.
export const ARTWORK_STATUSES = ['none', 'pending', 'approved', 'changes_requested'] as const
// Per artwork version.
export const APPROVAL_STATUSES = ['pending', 'approved', 'changes_requested'] as const
export const ESTIMATE_STATUSES = ['draft', 'sent', 'accepted', 'declined'] as const
export const PO_STATUSES = ['requested', 'received', 'under_review', 'approved', 'rejected', 'correction_required'] as const
export const PRODUCTION_STATUSES = [
  'awaiting_authorization',
  'awaiting_artwork',
  'ready',
  'in_production',
  'quality_control',
  'ready_for_pickup',
  'completed',
] as const
export const INQUIRY_STATUSES = ['new', 'converted', 'spam'] as const

export type Role = (typeof ROLES)[number]
export type CustomerKind = (typeof CUSTOMER_KINDS)[number]
export type OrderSource = (typeof ORDER_SOURCES)[number]
export type OrderState = (typeof ORDER_STATES)[number]
export type Method = (typeof METHODS)[number]
export type ArtworkStatus = (typeof ARTWORK_STATUSES)[number]
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number]
export type PoStatus = (typeof PO_STATUSES)[number]
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number]
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number]
