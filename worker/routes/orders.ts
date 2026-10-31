import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../auth'
import { ORDER_VIEWS } from '../../shared/api'
import type { ApiErrorCode, DashboardResponse, OrderDetailResponse, OrdersListResponse, PoChangeResponse } from '../../shared/api'
import { PO_STATUSES, PRODUCTION_STATUSES } from '../../shared/enums'
import { buildActionRequired, buildDashboard } from '../domain/dashboard'
import { parseOrderNumber } from '../domain/orderNumber'
import { checkOrderProductionMove, chooseSlot } from '../domain/productionFlow'
import { gateResult, readiness } from '../domain/readiness'
import { checkPoTransition } from '../domain/purchaseOrder'
import * as db from '../db/orders'
import { listProduction, runningJobs } from '../db/production'
import { businessToday } from '../../shared/businessDate'

export const number = z.string().refine((s) => parseOrderNumber(s) !== null, 'invalid order number')
const poId = z.string().regex(/^[1-9]\d{0,14}$/, 'invalid purchase order id').transform(Number)
const listQuery = z.object({
  view: z.enum(ORDER_VIEWS).default('active'),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

export const bad = (c: Context, e: z.ZodError) => c.json({ error: `Invalid request: ${e.issues[0]?.path.join('.') || 'input'} ${e.issues[0]?.message ?? ''}`.trim(), code: 'invalid_request' satisfies ApiErrorCode }, 400)

export function orderRoutes() {
  return new Hono<AppEnv>()
    .get('/dashboard', async (c) => {
      const d = c.env.DB
      const [orders, readyAt, inquiries, recentActivity, production] = await Promise.all([
        db.listActiveDashOrders(d), db.readyForPickupSince(d), db.listNewInquiriesForDashboard(d), db.recentActivity(d), listProduction(d),
      ])
      const { metrics, attention, dueThisWeek } = buildDashboard(orders, readyAt, inquiries, businessToday(new Date()))
      const items = await db.itemsSummaries(d, attention.flatMap((a) => (a.orderId === null ? [] : [a.orderId])))
      const needsAttention = attention.map(({ orderId, ...a }) => ({ ...a, itemsSummary: orderId === null ? '' : (items.get(orderId) ?? '') }))
      return c.json<DashboardResponse>({
        metrics, needsAttention, dueThisWeek, recentActivity,
        currentJobs: production.current, upcoming: production.readyToStart.slice(0, 5), actionRequired: buildActionRequired(orders),
      })
    })
    .get('/orders', async (c) => {
      const parsed = listQuery.safeParse(c.req.query())
      if (!parsed.success) return bad(c, parsed.error)
      const { view, q, limit } = parsed.data
      const counts = await db.orderCounts(c.env.DB)
      if (view === 'inquiries') return c.json<OrdersListResponse>({ view, rows: await db.listInquiries(c.env.DB, q, limit), counts })
      return c.json<OrdersListResponse>({ view, rows: await db.listOrders(c.env.DB, view, q, limit), counts })
    })
    .get('/orders/:number', async (c) => {
      const n = number.safeParse(c.req.param('number'))
      if (!n.success) return bad(c, n.error)
      const detail = await db.getOrderDetail(c.env.DB, n.data)
      if (!detail) return c.json({ error: 'Order not found', code: 'not_found' satisfies ApiErrorCode }, 404)
      const { readinessInput, ...rest } = detail
      const r = readiness(readinessInput)
      return c.json<OrderDetailResponse>({ ...rest, gate: gateResult(readinessInput.state, r), readiness: r })
    })
    // THE production write: every move goes through checkOrderProductionMove, a start also through chooseSlot, then
    // applyProductionChange (one batch, version-guarded, readiness and slot re-asserted in SQL).
    .patch('/orders/:number/production', async (c) => {
      const n = number.safeParse(c.req.param('number'))
      const body = z.object({
        to: z.enum(PRODUCTION_STATUSES), expectedVersion: z.number().int().min(0), override: z.boolean().optional(), reason: z.string().trim().max(500).optional(),
      }).safeParse(await c.req.json().catch(() => null))
      if (!n.success) return bad(c, n.error)
      if (!body.success) return bad(c, body.error)
      const loaded = await db.loadForProductionChange(c.env.DB, n.data)
      if (!loaded) return c.json({ error: 'Order not found', code: 'not_found' satisfies ApiErrorCode }, 404)
      const stale = () => c.json({ error: 'Order changed, reload and retry', code: 'conflict_retry' satisfies ApiErrorCode }, 409)
      // The page's version, never this read's: a page opened before someone else's change gets 409.
      if (loaded.version !== body.data.expectedVersion) return stale()
      const r = readiness(loaded.input)
      const check = checkOrderProductionMove(loaded.state, loaded.from, body.data.to, r)
      if (!check.ok) {
        const gate = gateResult(loaded.state, r)
        // A refused start, or a move to 'ready' that readiness doesn't support, is the gate speaking.
        const gated = !r.ready && loaded.state === 'active' && (check.error === 'not_ready' || (check.error === 'readiness_status_mismatch' && body.data.to === 'ready'))
        const code: ApiErrorCode = gated ? 'gate_failed' : 'transition_not_allowed'
        return c.json({ error: `Production move refused: ${check.error}`, code, ...(gate.ok ? {} : { reasons: gate.reasons }) }, 409)
      }
      const user = c.get('user')
      const pickSlot = async () => {
        const running = await runningJobs(c.env.DB)
        const choice = chooseSlot({ occupied: running.map((j) => j.slot), override: body.data.override === true, role: user.role, reason: body.data.reason })
        return { choice, runningJob: running.find((j) => j.slot === 1)?.number }
      }
      const slotRefused = (error: string, runningJob: string | undefined) => {
        if (error === 'override_requires_owner') return c.json({ error: 'Only an owner can override', code: error satisfies ApiErrorCode }, 403)
        if (error === 'override_requires_reason') return c.json({ error: 'An override needs a reason', code: error satisfies ApiErrorCode }, 400)
        const code: ApiErrorCode = error === 'no_slot_available' ? 'no_slot_available' : 'production_busy'
        return c.json({ error: `Production move refused: ${code}`, code, ...(runningJob ? { runningJob } : {}) }, 409)
      }
      let slot: { slot: 1 | 2; overrideBy: number | null; reason: string | null } | undefined
      if (body.data.to === 'in_production') {
        const { choice, runningJob } = await pickSlot()
        if (!choice.ok) return slotRefused(choice.error, runningJob)
        slot = choice.overrideUsed ? { slot: 2, overrideBy: user.id, reason: body.data.reason ?? null } : { slot: 1, overrideBy: null, reason: null }
      }
      let changed: boolean
      try {
        changed = await db.applyProductionChange(c.env.DB, { orderId: loaded.id, actorId: user.id, from: loaded.from, to: body.data.to, expectedVersion: body.data.expectedVersion, slot })
      } catch (e) {
        // A start that lost the slot race between the read and the batch: the unique index, or the slot-2 triggers
        // (slot 1 emptied, or the owner deactivated, meanwhile). Nothing was written; explain with what holds now.
        if (!slot || !/orders\.production_slot|production_override_invalid|production_slot_invalid/.test(e instanceof Error ? e.message : String(e))) throw e
        const { choice, runningJob } = await pickSlot()
        return choice.ok ? stale() : slotRefused(choice.error, runningJob)
      }
      if (!changed) return stale()
      return c.json({ number: n.data, productionStatus: body.data.to, state: loaded.state, version: body.data.expectedVersion + 1 })
    })
    .patch('/orders/:number/purchase-orders/:poId', async (c) => {
      const n = number.safeParse(c.req.param('number'))
      const id = poId.safeParse(c.req.param('poId'))
      const body = z.object({ to: z.enum(PO_STATUSES), expectedVersion: z.number().int().min(0) }).safeParse(await c.req.json().catch(() => null))
      if (!n.success) return bad(c, n.error)
      if (!id.success) return bad(c, id.error)
      if (!body.success) return bad(c, body.error)
      const loaded = await db.loadForPoChange(c.env.DB, n.data, id.data)
      if (!loaded) return c.json({ error: 'Purchase order not found', code: 'not_found' satisfies ApiErrorCode }, 404)
      const check = checkPoTransition(loaded.po.status, body.data.to)
      if (!check.ok) return c.json({ error: check.error, code: 'po_transition_not_allowed' satisfies ApiErrorCode }, 409)
      const stale = () => c.json({ error: 'Order changed, reload and retry', code: 'conflict_retry' satisfies ApiErrorCode }, 409)
      if (body.data.expectedVersion !== loaded.version) return stale()
      // Guarded by the client's version; bumps it, and the re-derive in the same batch moves a pre-production status
      // to whatever readiness says after the change.
      const { changed, productionStatus, version } = await db.applyPoChange(c.env.DB, {
        orderId: loaded.orderId, poId: loaded.po.id, actorId: c.get('user').id, version: body.data.expectedVersion, from: loaded.po.status, to: body.data.to,
      })
      if (!changed) return stale()
      return c.json<PoChangeResponse>({ poId: loaded.po.id, status: body.data.to, productionStatus, version })
    })
}
