import { PRODUCTION_STATUSES_NEXT } from '../../shared/enums-next.ts'
import { checkProductionMove, checkUnitsCompleted, chooseSlot } from './productionFlow.ts'
const gate = { ready: true, preProductionStatus: 'ready' as const }
it('checks all production moves with a satisfied gate', () => {
  for (const from of PRODUCTION_STATUSES_NEXT) for (const to of PRODUCTION_STATUSES_NEXT) {
    const allowed = from !== to && (from.startsWith('awaiting_') && to === 'ready'
      || (from === 'ready' || from === 'quality_control') && to === 'in_production'
      || from === 'in_production' && ['quality_control', 'ready'].includes(to)
      || from === 'quality_control' && to === 'production_complete')
    expect(checkProductionMove(from, to, gate).ok, `${from} -> ${to}`).toBe(allowed)
  }
})
it('derives awaiting moves and gates starts, including QC rework', () => {
  const blocked = { ready: false, preProductionStatus: 'awaiting_artwork' as const }
  expect(checkProductionMove('awaiting_quote', 'awaiting_artwork', blocked).ok).toBe(true)
  expect(checkProductionMove('ready', 'awaiting_artwork', blocked).ok).toBe(true)
  expect(checkProductionMove('awaiting_quote', 'awaiting_materials', blocked).ok).toBe(false)
  expect(checkProductionMove('ready', 'in_production', blocked).ok).toBe(false)
  expect(checkProductionMove('quality_control', 'in_production', blocked).ok).toBe(false)
  expect(checkProductionMove('in_production', 'ready', blocked).ok).toBe(true)
})
it('chooses slots with owner-only, reasoned overrides and a hard cap', () => {
  expect(chooseSlot({ occupied: [], override: true, role: 'staff' })).toEqual({ ok: true, slot: 1, overrideUsed: false })
  expect(chooseSlot({ occupied: [2], override: false, role: 'staff' })).toMatchObject({ slot: 1, overrideUsed: false })
  expect(chooseSlot({ occupied: [1], override: false, role: 'owner' })).toMatchObject({ error: 'production_busy' })
  expect(chooseSlot({ occupied: [1], override: true, role: 'staff', reason: 'rush' })).toMatchObject({ error: 'override_requires_owner' })
  expect(chooseSlot({ occupied: [1], override: true, role: 'owner', reason: '  ' })).toMatchObject({ error: 'override_requires_reason' })
  expect(chooseSlot({ occupied: [1], override: true, role: 'owner', reason: 'rush' })).toEqual({ ok: true, slot: 2, overrideUsed: true })
  for (const override of [true, false]) expect(chooseSlot({ occupied: [1, 2], override, role: 'owner', reason: 'rush' })).toMatchObject({ error: 'no_slot_available' })
})
it('allows downward progress corrections within safe integer bounds', () => {
  for (const n of [0, 3, 10]) expect(checkUnitsCompleted(n, 10).ok).toBe(true)
  for (const n of [-1, 11, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(checkUnitsCompleted(n, 10).ok).toBe(false)
  expect(checkUnitsCompleted(0, 0).ok).toBe(true)
  expect(checkUnitsCompleted(0, 1.5).ok).toBe(false)
})
