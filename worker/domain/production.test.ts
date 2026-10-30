import { ARTWORK_STATUSES, ORDER_STATES, PO_STATUSES, PRODUCTION_STATUSES } from '../../shared/enums.ts'
import { canEnterProduction, checkProductionTransition, preProductionStatus } from './production.ts'
import type { GateOrder, GatePo, GateReason } from './production.ts'

const authorized: GateOrder = { state: 'active', artworkStatus: 'approved', poRequired: false, authorizedAt: '2026-10-30T00:00:00Z' }
const poOrder: GateOrder = { ...authorized, poRequired: true }

describe('production gate', () => {
  const cases: [Partial<GateOrder>, GatePo, GateReason[]][] = [
    [{ state: 'cancelled' }, null, ['order_not_active']],
    [{ artworkStatus: 'pending' }, null, ['artwork_not_approved']],
    [{ poRequired: true }, null, ['po_missing']],
    [{ poRequired: true }, { status: 'under_review' }, ['po_not_approved']],
    [{ authorizedAt: null }, null, ['not_authorized']],
    [{ state: 'completed', artworkStatus: 'none', poRequired: true }, null, ['order_not_active', 'artwork_not_approved', 'po_missing']],
    [{ state: 'cancelled', artworkStatus: 'changes_requested', poRequired: true }, { status: 'rejected' }, ['order_not_active', 'artwork_not_approved', 'po_not_approved']],
    [{ state: 'cancelled', artworkStatus: 'pending', authorizedAt: null }, null, ['order_not_active', 'artwork_not_approved', 'not_authorized']],
  ]
  it.each(cases)('reports all reasons for %j and %j', (changes, po, reasons) => {
    expect(canEnterProduction({ ...authorized, ...changes }, po)).toEqual({ ok: false, reasons })
  })
  it('allows direct authorization without a PO and ignores unrelated POs', () => {
    expect(canEnterProduction(authorized, null)).toEqual({ ok: true })
    expect(canEnterProduction(authorized, { status: 'rejected' })).toEqual({ ok: true })
    expect(canEnterProduction({ ...authorized, authorizedAt: null }, { status: 'approved' })).toEqual({ ok: false, reasons: ['not_authorized'] })
  })
  it('requires approved PO regardless of direct authorization', () => {
    for (const status of PO_STATUSES) {
      expect(canEnterProduction(poOrder, { status }).ok).toBe(status === 'approved')
    }
    expect(canEnterProduction({ ...poOrder, authorizedAt: null }, { status: 'approved' })).toEqual({ ok: true })
  })
  it('requires active state and approved artwork across their vocabularies', () => {
    for (const state of ORDER_STATES) expect(canEnterProduction({ ...authorized, state }, null).ok).toBe(state === 'active')
    for (const artworkStatus of ARTWORK_STATUSES) expect(canEnterProduction({ ...authorized, artworkStatus }, null).ok).toBe(artworkStatus === 'approved')
  })
})

describe('pre-production status', () => {
  it('prioritizes authorization over artwork', () => {
    expect(preProductionStatus({ ...authorized, artworkStatus: 'none', authorizedAt: null }, null)).toBe('awaiting_authorization')
    expect(preProductionStatus({ ...poOrder, artworkStatus: 'none' }, null)).toBe('awaiting_authorization')
    expect(preProductionStatus(poOrder, { status: 'under_review' })).toBe('awaiting_authorization')
    expect(preProductionStatus({ ...authorized, artworkStatus: 'none' }, null)).toBe('awaiting_artwork')
    expect(preProductionStatus(authorized, null)).toBe('ready')
    expect(preProductionStatus({ ...authorized, state: 'completed' }, null)).toBe('awaiting_artwork')
  })
})

describe('production transitions', () => {
  it('checks every pair against stage order', () => {
    for (const [source, from] of PRODUCTION_STATUSES.entries()) {
      for (const [target, to] of PRODUCTION_STATUSES.entries()) {
        const expected = source !== target && target >= 2 && (source < 2 ? target === 2 : target < source || target === source + 1)
        expect(checkProductionTransition(from, to, authorized, null).ok, `${from} → ${to}`).toBe(expected)
      }
    }
  })
  it('allows QC rework and active-order completion', () => {
    expect(checkProductionTransition('quality_control', 'in_production', authorized, null)).toEqual({ ok: true })
    expect(checkProductionTransition('ready_for_pickup', 'completed', authorized, null)).toEqual({ ok: true })
  })
  it('rechecks revoked approval for forward and backward moves', () => {
    for (const to of ['quality_control', 'ready'] as const) {
      expect(checkProductionTransition('in_production', to, poOrder, { status: 'rejected' }).ok).toBe(false)
    }
  })
  it('blocks every move for completed and cancelled orders', () => {
    for (const state of ['completed', 'cancelled'] as const) {
      for (const from of PRODUCTION_STATUSES) for (const to of PRODUCTION_STATUSES) {
        expect(checkProductionTransition(from, to, { ...authorized, state }, null).ok).toBe(false)
      }
    }
  })
  it('only permits the derived awaiting state, including after approval is lost', () => {
    expect(checkProductionTransition('in_production', 'awaiting_authorization', poOrder, null)).toEqual({ ok: true })
    expect(checkProductionTransition('in_production', 'awaiting_artwork', poOrder, null).ok).toBe(false)
    expect(checkProductionTransition('ready', 'awaiting_artwork', { ...authorized, artworkStatus: 'pending' }, null)).toEqual({ ok: true })
    expect(checkProductionTransition('awaiting_artwork', 'in_production', authorized, null).ok).toBe(false)
  })
})
