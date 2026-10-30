import { PRODUCTION_STATUSES } from '../../shared/enums.ts'
import type { ArtworkStatus, OrderState, PoStatus, ProductionStatus } from '../../shared/enums.ts'

export type GateOrder = {
  state: OrderState
  artworkStatus: ArtworkStatus
  poRequired: boolean
  authorizedAt: string | null
}
export type GatePo = { status: PoStatus } | null
export type GateReason = 'order_not_active' | 'artwork_not_approved' | 'po_missing' | 'po_not_approved' | 'not_authorized'
type GateResult = { ok: true } | { ok: false; reasons: GateReason[] }
type TransitionResult = { ok: true } | { ok: false; error: string }

export function canEnterProduction(order: GateOrder, latestPo: GatePo): GateResult {
  const reasons: GateReason[] = []
  if (order.state !== 'active') reasons.push('order_not_active')
  if (order.artworkStatus !== 'approved') reasons.push('artwork_not_approved')
  // A district's PO approval cannot be replaced by direct authorization.
  if (order.poRequired) {
    if (latestPo === null) reasons.push('po_missing')
    else if (latestPo.status !== 'approved') reasons.push('po_not_approved')
  } else if (order.authorizedAt === null) reasons.push('not_authorized')
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

export function preProductionStatus(order: GateOrder, latestPo: GatePo): ProductionStatus {
  const gate = canEnterProduction(order, latestPo)
  if (gate.ok) return 'ready'
  // Resolve authorization first so staff see the prerequisite blocking the work.
  if (gate.reasons.some(reason => reason === 'po_missing' || reason === 'po_not_approved' || reason === 'not_authorized')) {
    return 'awaiting_authorization'
  }
  return 'awaiting_artwork'
}

/**
 * The awaiting_* states are derived from their prerequisites, so when a PO changes
 * they follow it. Returns the new status, or null when nothing should move: orders
 * already at ready or later stay put (the gate blocks forward moves and the detail
 * response's gate shows why), and inactive orders are never touched.
 */
export function syncAwaitingStatus(current: ProductionStatus, order: GateOrder, latestPo: GatePo): ProductionStatus | null {
  if (order.state !== 'active') return null
  if (current !== 'awaiting_authorization' && current !== 'awaiting_artwork') return null
  const next = preProductionStatus(order, latestPo)
  return next === current ? null : next
}

export function checkProductionTransition(
  from: ProductionStatus, to: ProductionStatus, order: GateOrder, latestPo: GatePo,
): TransitionResult {
  // Closed orders must be reopened before production can change.
  if (order.state !== 'active') return { ok: false, error: 'Order is not active' }
  if (from === to) return { ok: false, error: 'Production status is unchanged' }
  const ready = PRODUCTION_STATUSES.indexOf('ready')
  const target = PRODUCTION_STATUSES.indexOf(to)
  // Awaiting states reflect prerequisites, rather than a manually selected workflow step.
  if (target < ready) {
    return to === preProductionStatus(order, latestPo)
      ? { ok: true }
      : { ok: false, error: 'Awaiting status does not match the production prerequisites' }
  }
  // Approval can be revoked during production, so every production move rechecks it.
  const gate = canEnterProduction(order, latestPo)
  if (!gate.ok) return { ok: false, error: `Production gate failed: ${gate.reasons.join(', ')}` }
  const source = PRODUCTION_STATUSES.indexOf(from)
  // Both awaiting states converge on ready; later stages cannot skip required work.
  if (source < ready ? target === ready : target < source || target === source + 1) return { ok: true }
  return { ok: false, error: 'Forward production moves must advance exactly one stage' }
}
