import { describe, expect, test } from 'vitest'
import type { OrderDetailResponse, PurchaseOrdersResponse, UploadResponse } from '../../shared/api'
import { JPEG, PDF, PNG, SVG, TIFF_LE, setupUploads } from './r2'

describe('create', () => {
  test('a PO in requested, only on a po_required order; the latest PO now drives authorization', async () => {
    const t = setupUploads()
    const n = '2026-0008' // po_required, PO 9 approved, no artwork yet
    const o = t.order(n)
    const res = await t.json('POST', `/orders/${n}/purchase-orders`, { poNumber: 'PO-2026-81', amountCents: 230300, expectedVersion: o.version })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as UploadResponse
    expect(t.one('SELECT order_id, po_number, amount_cents, status FROM purchase_orders WHERE id = ?', id))
      .toEqual({ order_id: o.id, po_number: 'PO-2026-81', amount_cents: 230300, status: 'requested' })
    // The new PO is the latest one, and it isn't approved: authorization is pending again.
    expect(t.order(n).production_status).toBe('awaiting_authorization')
    expect(t.activity(o.id).slice(-2).map((r) => r.action)).toEqual(['po_created', 'production_status_changed'])
    const before = t.footprint()
    const refused = await t.json('POST', '/orders/2026-0022/purchase-orders', { expectedVersion: t.order('2026-0022').version })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ code: 'po_not_required' })
    expect(t.footprint()).toEqual(before)
  })

  test('stale version and bad input change nothing', async () => {
    const t = setupUploads()
    const before = t.footprint()
    const v = t.order('2026-0008').version
    expect((await t.json('POST', '/orders/2026-0008/purchase-orders', { expectedVersion: v + 1 })).status).toBe(409)
    expect((await t.json('POST', '/orders/2026-0008/purchase-orders', { expectedVersion: v, amountCents: 1.5 })).status).toBe(400)
    expect((await t.json('POST', '/orders/2026-0008/purchase-orders', {})).status).toBe(400)
    expect(t.footprint()).toEqual(before)
  })
})

describe('details', () => {
  test('number and amount edit under the order version; a left-out field keeps its value, null clears it', async () => {
    const t = setupUploads()
    const n = '2026-0010' // PO 11 requested
    const o = t.order(n)
    const res = await t.json('PATCH', `/orders/${n}/purchase-orders/11/details`, { amountCents: 75000, expectedVersion: o.version })
    expect(res.status).toBe(200)
    expect(t.one('SELECT po_number, amount_cents, status FROM purchase_orders WHERE id = 11')).toEqual({ po_number: 'PO-2026-100', amount_cents: 75000, status: 'requested' })
    const row = t.activity(o.id).at(-1)!
    expect([row.action, JSON.parse(row.before!), JSON.parse(row.after!)]).toEqual(['po_details_updated',
      { po_id: 11, po_number: 'PO-2026-100', amount_cents: 73000 }, { po_id: 11, po_number: 'PO-2026-100', amount_cents: 75000 }])
    expect((await t.json('PATCH', `/orders/${n}/purchase-orders/11/details`, { poNumber: null, expectedVersion: t.order(n).version })).status).toBe(200)
    expect(t.one('SELECT po_number, amount_cents FROM purchase_orders WHERE id = 11')).toEqual({ po_number: null, amount_cents: 75000 })
    // No change: no write, no activity, same version.
    const before = t.footprint()
    const v = t.order(n).version
    expect((await t.json('PATCH', `/orders/${n}/purchase-orders/11/details`, { amountCents: 75000, expectedVersion: v })).status).toBe(200)
    expect([t.footprint(), t.order(n).version]).toEqual([before, v])
    // Stale, or another order's PO.
    expect((await t.json('PATCH', `/orders/${n}/purchase-orders/11/details`, { amountCents: 1, expectedVersion: v - 1 })).status).toBe(409)
    expect((await t.json('PATCH', `/orders/${n}/purchase-orders/1/details`, { amountCents: 1, expectedVersion: v })).status).toBe(404)
    expect(t.footprint()).toEqual(before)
  })
})

describe('documents', () => {
  test('pdf, png, jpeg and tiff are accepted, each a new document; listed with the PO and on the order detail', async () => {
    const t = setupUploads()
    const n = '2026-0012' // PO 13 under review
    const ids: number[] = []
    for (const [bytes, mime] of [[PDF, 'application/pdf'], [PNG, 'image/png'], [JPEG, 'image/jpeg'], [TIFF_LE, 'image/tiff']] as const) {
      const res = await t.upload(`/orders/${n}/purchase-orders/13/documents?expectedVersion=${t.order(n).version}`, bytes, mime, { filename: 'po.pdf' })
      expect(res.status, mime).toBe(201)
      ids.push(((await res.json()) as UploadResponse).id)
    }
    const { purchaseOrders } = (await (await t.json('GET', `/orders/${n}/purchase-orders`)).json()) as PurchaseOrdersResponse
    expect(purchaseOrders[0]).toMatchObject({ id: 13, status: 'under_review' })
    expect(purchaseOrders[0]!.documents.map((d) => [d.id, d.file.mime])).toEqual([[ids[3], 'image/tiff'], [ids[2], 'image/jpeg'], [ids[1], 'image/png'], [ids[0], 'application/pdf']])
    const detail = (await (await t.json('GET', `/orders/${n}`)).json()) as OrderDetailResponse
    expect(detail.purchaseOrders).toEqual(purchaseOrders)
    // Exactly one activity row per document; uploading doesn't move the PO's status.
    expect(t.activity(t.order(n).id).filter((r) => r.action === 'po_document_added')).toHaveLength(4)
    expect(t.one('SELECT status FROM purchase_orders WHERE id = 13')).toEqual({ status: 'under_review' })
    // The document is downloadable.
    expect((await t.get(`/files/${purchaseOrders[0]!.documents[0]!.file.id}`)).status).toBe(200)
  })

  test('an SVG PO document is refused, and so is a PO of another order or a stale version', async () => {
    const t = setupUploads()
    const n = '2026-0012'
    const before = t.footprint()
    const svg = await t.upload(`/orders/${n}/purchase-orders/13/documents?expectedVersion=${t.order(n).version}`, SVG, 'image/svg+xml')
    expect(svg.status).toBe(415)
    expect(await svg.json()).toMatchObject({ code: 'unsupported_file_type' })
    expect((await t.upload(`/orders/${n}/purchase-orders/1/documents?expectedVersion=${t.order(n).version}`, PDF, 'application/pdf')).status).toBe(404)
    expect((await t.upload(`/orders/${n}/purchase-orders/13/documents?expectedVersion=${t.order(n).version + 1}`, PDF, 'application/pdf')).status).toBe(409)
    expect((await t.upload(`/orders/${n}/purchase-orders/13/documents`, PDF, 'application/pdf')).status).toBe(400)
    expect(t.footprint()).toEqual(before)
    expect(t.r2.calls).toEqual([])
  })

  test('po_documents are write-once', () => {
    const t = setupUploads()
    t.sqlite.exec(`INSERT INTO po_documents (id, po_id, file_id) VALUES (50, 13, 1)`)
    expect(() => t.sqlite.exec('UPDATE po_documents SET file_id = 2 WHERE id = 50')).toThrow(/write-once/)
  })
})

test('401 on every PO endpoint, with nothing written', async () => {
  const t = setupUploads()
  const before = t.footprint()
  for (const [method, path] of [['GET', '/orders/2026-0008/purchase-orders'], ['POST', '/orders/2026-0008/purchase-orders'], ['PATCH', '/orders/2026-0010/purchase-orders/11/details']]) {
    expect((await t.json(method!, path!, { expectedVersion: 0 }, false)).status, `${method} ${path}`).toBe(401)
  }
  expect((await t.upload('/orders/2026-0012/purchase-orders/13/documents?expectedVersion=0', PDF, 'application/pdf', { auth: false })).status).toBe(401)
  expect(t.footprint()).toEqual(before)
  expect(t.r2.calls).toEqual([])
})
