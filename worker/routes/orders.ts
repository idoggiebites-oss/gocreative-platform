import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../auth'
import { ORDER_VIEWS } from '../../shared/api'
import type { ApiErrorCode, DashboardResponse, OrderDetailResponse, OrdersListResponse } from '../../shared/api'
import { PO_STATUSES, PRODUCTION_STATUSES } from '../../shared/enums'
import { buildDashboard } from '../domain/dashboard'
import { parseOrderNumber } from '../domain/orderNumber'
import { canEnterProduction, checkProductionTransition, syncAwaitingStatus } from '../domain/production'
import { checkPoTransition } from '../domain/purchaseOrder'
import * as db from '../db/orders'

const number = z.string().refine((s) => parseOrderNumber(s) !== null, 'invalid order number')
const poId = z.string().regex(/^[1-9]\d{0,14}$/, 'invalid purchase order id').transform(Number)
const listQuery = z.object({
  view: z.enum(ORDER_VIEWS).default('active'),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

const bad = (c: Context, e: z.ZodError) => c.json({ error: `Invalid request: ${e.issues[0]?.path.join('.') || 'input'} ${e.issues[0]?.message ?? ''}`.trim(), code: 'invalid_request' satisfies ApiErrorCode }, 400)

// ponytail: "today" is the UTC date; the shop's local timezone is a later refinement.
const todayUtc = () => new Date().toISOString().slice(0, 10)

export function orderRoutes() {
  return new Hono<AppEnv>()
    .get('/dashboard', async (c) => {
      const d = c.env.DB
      const [orders, readyAt, inquiries, recentActivity] = await Promise.all([
        db.listActiveDashOrders(d), db.readyForPickupSince(d), db.listNewInquiriesForDashboard(d), db.recentActivity(d),
      ])
      const { metrics, attention, dueThisWeek } = buildDashboard(orders, readyAt, inquiries, todayUtc())
      const items = await db.itemsSummaries(d, attention.flatMap((a) => (a.orderId === null ? [] : [a.orderId])))
      const needsAttention = attention.map(({ orderId, ...a }) => ({ ...a, itemsSummary: orderId === null ? '' : (items.get(orderId) ?? '') }))
      return c.json<DashboardResponse>({ metrics, needsAttention, dueThisWeek, recentActivity })
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
      const { gateInput, ...rest } = detail
      return c.json<OrderDetailResponse>({ ...rest, gate: canEnterProduction(gateInput.order, gateInput.latestPo) })
    })
    .patch('/orders/:number/production', async (c) => {
      const n = number.safeParse(c.req.param('number'))
      const body = z.object({ to: z.enum(PRODUCTION_STATUSES) }).safeParse(await c.req.json().catch(() => null))
      if (!n.success) return bad(c, n.error)
      if (!body.success) return bad(c, body.error)
      const loaded = await db.loadForProductionChange(c.env.DB, n.data)
      if (!loaded) return c.json({ error: 'Order not found', code: 'not_found' satisfies ApiErrorCode }, 404)
      const check = checkProductionTransition(loaded.from, body.data.to, loaded.order, loaded.latestPo)
      if (!check.ok) {
        const gate = canEnterProduction(loaded.order, loaded.latestPo)
        const code: ApiErrorCode = !gate.ok && check.error.startsWith('Production gate failed') ? 'gate_failed' : 'transition_not_allowed'
        return c.json({ error: check.error, code, ...(gate.ok ? {} : { reasons: gate.reasons }) }, 409)
      }
      const changed = await db.applyProductionChange(c.env.DB, { orderId: loaded.id, actorId: c.get('user').id, from: loaded.from, to: body.data.to })
      if (!changed) return c.json({ error: 'Order changed, reload and retry', code: 'conflict_retry' satisfies ApiErrorCode }, 409)
      return c.json({ number: n.data, productionStatus: body.data.to, state: body.data.to === 'completed' ? 'completed' : loaded.order.state })
    })
    .patch('/orders/:number/purchase-orders/:poId', async (c) => {
      const n = number.safeParse(c.req.param('number'))
      const id = poId.safeParse(c.req.param('poId'))
      const body = z.object({ to: z.enum(PO_STATUSES) }).safeParse(await c.req.json().catch(() => null))
      if (!n.success) return bad(c, n.error)
      if (!id.success) return bad(c, id.error)
      if (!body.success) return bad(c, body.error)
      const loaded = await db.loadForPoChange(c.env.DB, n.data, id.data)
      if (!loaded) return c.json({ error: 'Purchase order not found', code: 'not_found' satisfies ApiErrorCode }, 404)
      const check = checkPoTransition(loaded.po.status, body.data.to)
      if (!check.ok) return c.json({ error: check.error, code: 'po_transition_not_allowed' satisfies ApiErrorCode }, 409)
      // The order's latest PO after this change: the edited one if it is the latest, else unchanged.
      const latestAfter = loaded.latestPoId === loaded.po.id ? { status: body.data.to } : loaded.latestPo
      const syncTo = syncAwaitingStatus(loaded.productionStatus, loaded.order, latestAfter)
      const { changed, productionStatus } = await db.applyPoChange(c.env.DB, {
        orderId: loaded.orderId, poId: loaded.po.id, actorId: c.get('user').id, from: loaded.po.status, to: body.data.to,
        productionFrom: loaded.productionStatus, sync: syncTo !== null,
      })
      if (!changed) return c.json({ error: 'Purchase order changed, reload and retry', code: 'conflict_retry' satisfies ApiErrorCode }, 409)
      return c.json({ poId: loaded.po.id, status: body.data.to, productionStatus })
    })
}
