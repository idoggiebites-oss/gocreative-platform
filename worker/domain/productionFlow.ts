import type { OrderState, ProductionStatus } from '../../shared/enums.ts'
import type { Readiness } from './readiness.ts'

// Closed and cancelled orders must be reopened before production can change.
export function checkOrderProductionMove(state: OrderState, from: ProductionStatus, to: ProductionStatus, gate: Pick<Readiness, 'ready' | 'preProductionStatus'>): Result {
  return state === 'active' ? checkProductionMove(from, to, gate) : { ok: false, error: 'order_not_active' }
}
/**
 * The awaiting_* states follow their prerequisites (e.g. when a PO changes). Returns the new status, or null
 * when nothing should move: orders at ready or later stay put (the detail's readiness shows why), and
 * inactive orders are never touched.
 */
export function syncAwaitingStatus(current: ProductionStatus, state: OrderState, gate: Pick<Readiness, 'preProductionStatus'>): ProductionStatus | null {
  if (state !== 'active' || !current.startsWith('awaiting_')) return null
  return gate.preProductionStatus === current ? null : gate.preProductionStatus
}

type Result = { ok: true } | { ok: false; error: string }
export function checkProductionMove(from: ProductionStatus, to: ProductionStatus, gate: Pick<Readiness, 'ready' | 'preProductionStatus'>): Result {
  if (from === to || from === 'production_complete') return { ok: false, error: 'invalid_production_move' }
  // Awaiting states reflect prerequisites, never a way to skip production or QC.
  if ((from.startsWith('awaiting_') || from === 'ready') && (to.startsWith('awaiting_') || to === 'ready')) {
    return to === gate.preProductionStatus ? { ok: true } : { ok: false, error: 'readiness_status_mismatch' }
  }
  // Starting again after failed QC must recheck approvals; pausing frees the slot.
  if ((from === 'ready' || from === 'quality_control') && to === 'in_production') {
    return gate.ready ? { ok: true } : { ok: false, error: 'not_ready' }
  }
  if (from === 'in_production' && to === 'quality_control') return { ok: true }
  // Pausing returns to whatever readiness now says (e.g. a PO revoked mid-run), not a fixed 'ready'.
  if (from === 'in_production' && (to.startsWith('awaiting_') || to === 'ready')) {
    return to === gate.preProductionStatus ? { ok: true } : { ok: false, error: 'readiness_status_mismatch' }
  }
  if (from === 'quality_control' && to === 'production_complete') return { ok: true }
  return { ok: false, error: 'invalid_production_move' }
}
export function chooseSlot(input: { occupied: (1 | 2)[]; override: boolean; role: 'owner' | 'staff'; reason?: string }): { ok: true; slot: 1 | 2; overrideUsed: boolean } | { ok: false; error: string } {
  if (!input.occupied.includes(1)) return { ok: true, slot: 1, overrideUsed: false }
  // The database cap applies even to an owner with an override.
  if (input.occupied.includes(2)) return { ok: false, error: 'no_slot_available' }
  if (!input.override) return { ok: false, error: 'production_busy' }
  if (input.role !== 'owner') return { ok: false, error: 'override_requires_owner' }
  if (!input.reason?.trim()) return { ok: false, error: 'override_requires_reason' }
  return { ok: true, slot: 2, overrideUsed: true }
}
export function checkUnitsCompleted(n: number, totalQuantity: number): Result {
  return Number.isSafeInteger(n) && Number.isSafeInteger(totalQuantity) && n >= 0 && totalQuantity >= n
    ? { ok: true } : { ok: false, error: 'invalid_units_completed' }
}
