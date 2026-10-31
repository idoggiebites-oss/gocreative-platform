// The production queue (M4): the Production page's data, units completed, and the ready-queue order. HTTP and validation
// only: the rules are in worker/domain/productionFlow.ts, the SQL in worker/db/production.ts. Production moves themselves
// (start, QC, complete, pause) are the one PATCH /orders/:number/production in routes/orders.ts.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../auth'
import type { ApiErrorCode, OrderWriteResponse, ProductionResponse, QueueReorderResponse } from '../../shared/api'
import { checkQueueReorder, checkUnitsCompleted, UNITS_EDITABLE } from '../domain/productionFlow'
import { getOrderByNumber, orderState } from '../db/orders'
import * as db from '../db/production'
import { bad, number } from './orders'

type C = Context<AppEnv>
const refuse = (c: C, code: ApiErrorCode, error: string, status: 400 | 404 | 409 = 409) => c.json({ error, code }, status)
const conflict = (c: C) => refuse(c, 'conflict_retry', 'Changed by someone else, reload and retry')

const unitsBody = z.object({ unitsCompleted: z.number().int().min(0).max(1_000_000_000), expectedVersion: z.number().int().min(0) })
const queueBody = z.object({ seen: z.array(number).max(500), orderNumbers: z.array(number).min(1).max(500) })

export function productionRoutes() {
  return new Hono<AppEnv>()
    .get('/production', async (c) => c.json<ProductionResponse>(await db.listProduction(c.env.DB)))

    .patch('/orders/:number/units', async (c) => {
      const n = number.safeParse(c.req.param('number'))
      if (!n.success) return bad(c, n.error)
      const b = unitsBody.safeParse(await c.req.json().catch(() => null))
      if (!b.success) return bad(c, b.error)
      const o = await getOrderByNumber(c.env.DB, n.data)
      if (!o) return refuse(c, 'not_found', 'Order not found', 404)
      if (b.data.expectedVersion !== o.version) return conflict(c)
      if (o.state !== 'active') return refuse(c, 'order_not_active', 'Order is cancelled or closed')
      if (!UNITS_EDITABLE.includes(o.production_status)) return refuse(c, 'units_not_editable', 'Units are recorded only in production or quality control')
      const check = checkUnitsCompleted(b.data.unitsCompleted, await db.totalQuantity(c.env.DB, o.id))
      if (!check.ok) return refuse(c, 'invalid_units_completed', 'Units completed must be between 0 and the order quantity', 400)
      if (b.data.unitsCompleted === o.units_completed) return c.json<OrderWriteResponse>((await orderState(c.env.DB, { id: o.id }))!)
      const state = await db.setUnitsCompleted(c.env.DB, { orderId: o.id, version: o.version, actorId: c.get('user').id, from: o.units_completed, to: b.data.unitsCompleted })
      return state ? c.json<OrderWriteResponse>(state) : conflict(c)
    })

    .post('/production/queue', async (c) => {
      const b = queueBody.safeParse(await c.req.json().catch(() => null))
      if (!b.success) return bad(c, b.error)
      if (!checkQueueReorder(b.data.seen, b.data.orderNumbers).ok) return refuse(c, 'invalid_request', 'orderNumbers must be the seen list, reordered', 400)
      // The SQL re-checks the queue is still `seen`; this read only answers early.
      if (JSON.stringify(await db.readyQueue(c.env.DB)) !== JSON.stringify(b.data.seen)) return conflict(c)
      if (!(await db.reorderQueue(c.env.DB, { actorId: c.get('user').id, seen: b.data.seen, next: b.data.orderNumbers }))) return conflict(c)
      return c.json<QueueReorderResponse>({ readyToStart: await db.readyQueue(c.env.DB) })
    })
}
