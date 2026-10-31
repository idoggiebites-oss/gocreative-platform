// Artwork versions and approvals, purchase orders and their documents (M2a). HTTP, auth and validation only: the
// decision rule is in worker/domain/artwork.ts, uploads in worker/files.ts, the SQL in worker/db/files.ts.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../auth'
import type { ApiErrorCode, ArtworkListResponse, OrderWriteResponse, PurchaseOrdersResponse, UploadResponse } from '../../shared/api'
import { AUTHORIZATION_METHODS } from '../../shared/enums'
import { checkArtworkDecision } from '../domain/artwork'
import * as files from '../db/files'
import { getOrderByNumber, orderState } from '../db/orders'
import { ARTWORK_KINDS, PO_DOCUMENT_KINDS, storeUpload } from '../files'
import { bad, number } from './orders'

type C = Context<AppEnv>
type Order = NonNullable<Awaited<ReturnType<typeof getOrderByNumber>>>

const pathId = z.string().regex(/^[1-9]\d{0,14}$/, 'invalid id').transform(Number)
const queryInt = z.string().regex(/^\d{1,15}$/, 'must be a whole number').transform(Number)
const expectedVersion = z.number().int().min(0)
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null)
const amountCents = z.number().int().min(0).nullish()

const refuse = (c: C, code: ApiErrorCode, error: string, status: 400 | 404 | 409 = 409) => c.json({ error, code }, status)
const conflict = (c: C) => refuse(c, 'conflict_retry', 'Order changed, reload and retry')
const notFound = (c: C, what: string) => refuse(c, 'not_found', `${what} not found`, 404)
const notActive = (c: C) => refuse(c, 'order_not_active', 'Order is cancelled or closed')
const written = (c: C, state: Awaited<ReturnType<typeof orderState>>, status: 200 | 201 = 200) => (state ? c.json<OrderWriteResponse>(state, status) : conflict(c))
const created = (c: C, r: { state: NonNullable<Awaited<ReturnType<typeof orderState>>>; id: number } | null) =>
  r ? c.json<UploadResponse>({ ...r.state, id: r.id }, 201) : conflict(c)
/** An upload's batch committed (or didn't: 409); the order's new state is read only now, after storeUpload's cleanup decision. */
async function uploaded(c: C, orderId: number, stored: { response: Response } | { result: { id: number } | null }) {
  if ('response' in stored) return stored.response
  if (!stored.result) return conflict(c)
  const state = await orderState(c.env.DB, { id: orderId })
  if (!state) throw new Error(`order ${orderId} vanished after an upload committed`)
  return c.json<UploadResponse>({ ...state, id: stored.result.id }, 201)
}

/** Loads :number (404) and refuses a stale expectedVersion before anything runs; the batch re-checks the client's version. */
async function loadOrder(c: C, sent?: number): Promise<Order | Response> {
  const n = number.safeParse(c.req.param('number'))
  if (!n.success) return bad(c, n.error)
  const o = await getOrderByNumber(c.env.DB, n.data)
  if (!o) return notFound(c, 'Order')
  if (sent !== undefined && sent !== o.version) return conflict(c)
  return o
}
const jsonBody = <S extends z.ZodType>(c: C, schema: S) => c.req.json().catch(() => null).then((b) => schema.safeParse(b) as z.ZodSafeParseResult<z.infer<S>>)

const uploadQuery = z.object({
  expectedVersion: queryInt,
  designName: z.string().trim().max(200).optional().transform((v) => v || null),
  lineageId: queryInt.optional(),
})
const decisionBody = z.object({
  to: z.enum(['approved', 'changes_requested']), via: z.enum(AUTHORIZATION_METHODS).nullish(), note: optText(2000), expectedVersion,
}).refine((b) => b.to !== 'approved' || b.via, { message: 'approval needs how the customer approved (via)', path: ['via'] })
const poBody = z.object({ poNumber: optText(100), amountCents, expectedVersion })
// Creating a PO while the latest one is approved must say so, and why (it becomes a po_replaced activity row).
const poCreateBody = poBody.extend({ replaceApproved: z.boolean().optional(), reason: optText(500) })

export function artworkRoutes() {
  return new Hono<AppEnv>()
    .onError((e, c) => {
      const message = e instanceof Error ? e.message : String(e)
      // Two uploads raced for one version number, or a design / PO vanished between the read and the batch: retry.
      if (/UNIQUE constraint failed: artwork\.|artwork_version_exists|NOT NULL constraint failed: (artwork|po_documents)\./.test(message)) return conflict(c)
      console.error(e)
      return c.json({ error: 'Internal error' }, 500)
    })

    .get('/orders/:number/artwork', async (c) => {
      const o = await loadOrder(c)
      if (o instanceof Response) return o
      return c.json<ArtworkListResponse>({ designs: await files.listDesigns(c.env.DB, { orderId: o.id }) })
    })

    .post('/orders/:number/artwork', async (c) => {
      const q = uploadQuery.safeParse(c.req.query())
      if (!q.success) return bad(c, q.error)
      const o = await loadOrder(c, q.data.expectedVersion)
      if (o instanceof Response) return o
      if (o.state !== 'active') return notActive(c)
      const { lineageId, designName, expectedVersion: version } = q.data
      let nextVersion = 1
      if (lineageId !== undefined) {
        const head = await files.getDesignHead(c.env.DB, o.id, lineageId)
        if (!head) return notFound(c, 'Design')
        nextVersion = head.version + 1
      }
      const stored = await storeUpload(c, o.id, ARTWORK_KINDS, (file) => files.uploadArtwork(c.env.DB, {
        orderId: o.id, version, actorId: c.get('user').id, file, lineageId, designName: lineageId === undefined ? designName : null, nextVersion,
      }))
      return uploaded(c, o.id, stored)
    })

    .patch('/orders/:number/artwork/:artworkId', async (c) => {
      const artworkId = pathId.safeParse(c.req.param('artworkId'))
      if (!artworkId.success) return bad(c, artworkId.error)
      const b = await jsonBody(c, decisionBody)
      if (!b.success) return bad(c, b.error)
      const o = await loadOrder(c, b.data.expectedVersion)
      if (o instanceof Response) return o
      if (o.state !== 'active') return notActive(c)
      const a = await files.getArtworkVersion(c.env.DB, o.id, artworkId.data)
      if (!a) return notFound(c, 'Artwork version')
      const check = checkArtworkDecision({ approval: a.approval_status, isCurrent: a.is_current === 1 }, b.data.to)
      if (!check.ok) return refuse(c, check.error, check.error === 'not_current_version' ? 'Only the current version of a design can be decided' : 'Already decided that way')
      return written(c, await files.decideArtwork(c.env.DB, {
        orderId: o.id, version: b.data.expectedVersion, actorId: c.get('user').id, artwork: a, to: b.data.to, via: b.data.via ?? null, note: b.data.note,
      }))
    })

    .get('/customers/:id/artwork', async (c) => {
      const id = pathId.safeParse(c.req.param('id'))
      if (!id.success) return bad(c, id.error)
      if (!(await files.customerExists(c.env.DB, id.data))) return notFound(c, 'Customer')
      return c.json<ArtworkListResponse>({ designs: await files.listDesigns(c.env.DB, { customerId: id.data }) })
    })

    .get('/orders/:number/purchase-orders', async (c) => {
      const o = await loadOrder(c)
      if (o instanceof Response) return o
      return c.json<PurchaseOrdersResponse>({ purchaseOrders: await files.listPurchaseOrders(c.env.DB, o.id) })
    })

    .post('/orders/:number/purchase-orders', async (c) => {
      const b = await jsonBody(c, poCreateBody)
      if (!b.success) return bad(c, b.error)
      const o = await loadOrder(c, b.data.expectedVersion)
      if (o instanceof Response) return o
      if (o.state !== 'active') return notActive(c)
      if (o.po_required !== 1) return refuse(c, 'po_not_required', 'This order does not need a purchase order')
      const latest = await files.getLatestPurchaseOrder(c.env.DB, o.id)
      const replacing = latest?.status === 'approved'
      if (replacing && !(b.data.replaceApproved === true && b.data.reason)) {
        return refuse(c, 'po_approved_exists', 'The latest purchase order is approved; replacing it needs replaceApproved and a reason')
      }
      return created(c, await files.createPurchaseOrder(c.env.DB, {
        orderId: o.id, version: b.data.expectedVersion, actorId: c.get('user').id, poNumber: b.data.poNumber, amountCents: b.data.amountCents ?? null,
        replaces: replacing ? { poId: latest.id, reason: b.data.reason! } : undefined,
      }))
    })

    .patch('/orders/:number/purchase-orders/:poId/details', async (c) => {
      const poId = pathId.safeParse(c.req.param('poId'))
      if (!poId.success) return bad(c, poId.error)
      const raw: unknown = await c.req.json().catch(() => null)
      const b = poBody.safeParse(raw)
      if (!b.success) return bad(c, b.error)
      const o = await loadOrder(c, b.data.expectedVersion)
      if (o instanceof Response) return o
      if (o.state !== 'active') return notActive(c)
      const po = await files.getPurchaseOrder(c.env.DB, o.id, poId.data)
      if (!po) return notFound(c, 'Purchase order')
      if (po.status === 'approved') return refuse(c, 'po_approved_locked', 'An approved purchase order cannot be edited')
      // A field left out keeps its value; null clears it.
      const sent = raw as Record<string, unknown>
      const before = { poNumber: po.po_number, amountCents: po.amount_cents }
      const after = { poNumber: 'poNumber' in sent ? b.data.poNumber : po.po_number, amountCents: 'amountCents' in sent ? (b.data.amountCents ?? null) : po.amount_cents }
      if (after.poNumber === before.poNumber && after.amountCents === before.amountCents) return written(c, await orderState(c.env.DB, { id: o.id }))
      return written(c, await files.updatePurchaseOrderDetails(c.env.DB, { orderId: o.id, version: b.data.expectedVersion, actorId: c.get('user').id, poId: po.id, before, after }))
    })

    .post('/orders/:number/purchase-orders/:poId/documents', async (c) => {
      const poId = pathId.safeParse(c.req.param('poId'))
      if (!poId.success) return bad(c, poId.error)
      const q = z.object({ expectedVersion: queryInt }).safeParse(c.req.query())
      if (!q.success) return bad(c, q.error)
      const o = await loadOrder(c, q.data.expectedVersion)
      if (o instanceof Response) return o
      if (o.state !== 'active') return notActive(c)
      const po = await files.getPurchaseOrder(c.env.DB, o.id, poId.data)
      if (!po) return notFound(c, 'Purchase order')
      const stored = await storeUpload(c, o.id, PO_DOCUMENT_KINDS, (file) => files.addPoDocument(c.env.DB, {
        orderId: o.id, version: q.data.expectedVersion, actorId: c.get('user').id, poId: po.id, file,
      }))
      return uploaded(c, o.id, stored)
    })
}
