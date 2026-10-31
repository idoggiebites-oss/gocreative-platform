import { describe, expect, test } from 'vitest'
import type { ArtworkListResponse, OrderDetailResponse, OrderWriteResponse, UploadResponse } from '../../shared/api'
import { decideArtwork } from '../../worker/db/files'
import { PNG, SVG, setupUploads, type Uploads } from './r2'

const up = (t: Uploads, n: string, query = '', bytes = PNG, mime = 'image/png') =>
  t.upload(`/orders/${n}/artwork?expectedVersion=${t.order(n).version}${query}`, bytes, mime, { filename: 'art.png' })
const decide = (t: Uploads, n: string, artworkId: number, body: object) =>
  t.json('PATCH', `/orders/${n}/artwork/${artworkId}`, { expectedVersion: t.order(n).version, ...body })
const detail = async (t: Uploads, n: string) => (await (await t.json('GET', `/orders/${n}`)).json()) as OrderDetailResponse
const artworkItem = (d: OrderDetailResponse) => d.readiness.items.find((i) => i.key === 'artwork')

describe('designs and versions', () => {
  test('a new design, then a new version of it; listed newest first on the artwork route and the order detail', async () => {
    const t = setupUploads()
    const n = '2026-0022'
    const v0 = t.order(n).version
    const first = await up(t, n, '&designName=Front%20logo')
    expect(first.status).toBe(201)
    const a = (await first.json()) as UploadResponse
    expect(a).toMatchObject({ number: n, version: v0 + 1 })
    const lineage = t.one<{ lineage_id: number }>('SELECT lineage_id FROM artwork WHERE id = ?', a.id).lineage_id
    const second = (await (await up(t, n, `&lineageId=${lineage}`, SVG, 'image/svg+xml')).json()) as UploadResponse
    expect(t.one('SELECT lineage_id, version, design_name, approval_status FROM artwork WHERE id = ?', second.id))
      .toEqual({ lineage_id: lineage, version: 2, design_name: 'Front logo', approval_status: 'under_review' })
    const list = (await (await t.json('GET', `/orders/${n}/artwork`)).json()) as ArtworkListResponse
    expect(list.designs).toHaveLength(1)
    expect(list.designs[0]).toMatchObject({ lineageId: lineage, name: 'Front logo', orderNumber: n })
    expect(list.designs[0]!.versions.map((v) => [v.id, v.version, v.file.mime, v.file.filename, v.file.uploadedBy])).toEqual([
      [second.id, 2, 'image/svg+xml', 'art.png', 'Owner One'], [a.id, 1, 'image/png', 'art.png', 'Owner One'],
    ])
    expect((await detail(t, n)).designs).toEqual(list.designs)
    // One activity row per upload, no more.
    expect(t.activity(t.order(n).id).filter((r) => r.action === 'artwork_uploaded').map((r) => JSON.parse(r.after!))).toEqual([
      { artwork_version: 1, design_name: 'Front logo' }, { lineage_id: lineage, artwork_version: 2 },
    ])
  })

  test('a version of a design that is not on this order is 404, with nothing written', async () => {
    const t = setupUploads()
    const before = t.footprint()
    const res = await up(t, '2026-0022', '&lineageId=7') // order 7's design
    expect(res.status).toBe(404)
    expect(t.footprint()).toEqual(before)
    expect(t.r2.calls).toEqual([])
  })

  test('a new version resets approval: the order drops from ready back to awaiting_artwork', async () => {
    const t = setupUploads()
    const n = '2026-0017' // ready; one approved design, lineage 17
    expect(artworkItem(await detail(t, n))).toEqual({ key: 'artwork', state: 'complete' })
    expect((await up(t, n, '&lineageId=17')).status).toBe(201)
    const d = await detail(t, n)
    expect(artworkItem(d)).toEqual({ key: 'artwork', state: 'pending', reason: 'under_review' })
    expect(d.order).toMatchObject({ artworkStatus: 'under_review', productionStatus: 'awaiting_artwork' })
    expect(t.activity(t.order(n).id).slice(-2).map((r) => r.action)).toEqual(['artwork_uploaded', 'production_status_changed'])
  })

  test('uploads to a cancelled order are refused', async () => {
    const t = setupUploads()
    const res = await up(t, '2026-0024')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'order_not_active' })
    expect(t.r2.calls).toEqual([])
  })
})

describe('stale order version', () => {
  test('refused before anything is stored', async () => {
    const t = setupUploads()
    const before = t.footprint()
    const res = await t.upload(`/orders/2026-0022/artwork?expectedVersion=${t.order('2026-0022').version - 1 + 10}`, PNG, 'image/png')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'conflict_retry' })
    expect(t.footprint()).toEqual(before)
    expect(t.r2.calls).toEqual([])
  })

  test('lost between the read and the batch: no files row, and the R2 object is deleted', async () => {
    const t = setupUploads()
    const before = t.footprint()
    // A colleague's write lands just before this upload's batch.
    const racing = {
      prepare: t.db.prepare.bind(t.db),
      batch: async (stmts: unknown[]) => {
        t.sqlite.exec(`UPDATE orders SET version = version + 1 WHERE number = '2026-0022'`)
        return t.db.batch(stmts as Parameters<typeof t.db.batch>[0])
      },
    } as unknown as typeof t.db
    const res = await t.upload(`/orders/2026-0022/artwork?expectedVersion=${t.order('2026-0022').version}`, PNG, 'image/png', { DB: racing })
    expect(res.status).toBe(409)
    expect(t.r2.calls.map(([op]) => op)).toEqual(['put', 'delete'])
    expect(t.footprint()).toEqual(before)
  })
})

describe('approval', () => {
  test('only the current version can be decided', async () => {
    const t = setupUploads()
    const before = t.footprint()
    // Order 7: design 7 has v1 (id 7, changes requested) and v2 (id 107, under review).
    const res = await decide(t, '2026-0007', 7, { to: 'approved', via: 'email' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'not_current_version' })
    expect(t.footprint()).toEqual(before)
  })

  // Codex security review of 1729ff4: the route refuses this first, so only a direct call proves the SQL guard.
  test('decideArtwork itself changes nothing on an obsolete version, even when told it is current', async () => {
    const t = setupUploads()
    const o = t.order('2026-0007')
    const before = t.footprint()
    const row = () => t.one('SELECT approval_status, approved_at, approved_via, approval_recorded_by, notes FROM artwork WHERE id = 7')
    const was = row()
    // v1 (id 7) of design 7, changes requested; v2 (id 107) is the current one.
    const state = await decideArtwork(t.db, {
      orderId: o.id, version: o.version, actorId: 1, to: 'approved', via: 'email', note: 'should not land',
      artwork: { id: 7, lineage_id: 7, version: 1, approval_status: 'changes_requested', is_current: 1 },
    })
    expect(state).toBeNull()
    expect([row(), t.order('2026-0007').version, t.footprint()]).toEqual([was, o.version, before])
  })

  test('approving needs `via`', async () => {
    const t = setupUploads()
    const v = t.order('2026-0007').version
    const res = await decide(t, '2026-0007', 107, { to: 'approved' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid_request' })
    expect(t.order('2026-0007').version).toBe(v)
  })

  test('approve records when, how and who; the note stays on the version, out of the activity log; readiness moves on', async () => {
    const t = setupUploads()
    const n = '2026-0007'
    const o = t.order(n)
    const activity = t.activity(o.id).length
    const res = await decide(t, n, 107, { to: 'approved', via: 'signed_form', note: 'Signed by the AD, scanned' })
    expect(res.status).toBe(200)
    expect((await res.json()) as OrderWriteResponse).toMatchObject({ productionStatus: 'awaiting_preparation' })
    expect(t.one('SELECT approval_status, approved_via, approval_recorded_by, notes, approved_at IS NOT NULL AS stamped FROM artwork WHERE id = 107'))
      .toEqual({ approval_status: 'approved', approved_via: 'signed_form', approval_recorded_by: 1, notes: 'Signed by the AD, scanned', stamped: 1 })
    const rows = t.activity(o.id).slice(activity)
    expect(rows.map((r) => r.action)).toEqual(['artwork_decided', 'production_status_changed'])
    expect(JSON.parse(rows[0]!.after!)).toEqual({ artwork_id: 107, lineage_id: 7, artwork_version: 2, approval_status: 'approved', approved_via: 'signed_form' })
    expect(JSON.stringify(rows)).not.toContain('Signed by')
    const d = await detail(t, n)
    expect(d.designs[0]!.versions[0]).toMatchObject({ approvalStatus: 'approved', approvedVia: 'signed_form', approvalRecordedBy: 'Owner One', notes: 'Signed by the AD, scanned' })
    expect(JSON.stringify(d.activity)).not.toContain('Signed by')
    // The same decision again is refused; sending it back clears the approval and keeps the file.
    expect(await (await decide(t, n, 107, { to: 'approved', via: 'email' })).json()).toMatchObject({ code: 'artwork_unchanged' })
    expect((await decide(t, n, 107, { to: 'changes_requested', note: 'Wrong green' })).status).toBe(200)
    expect(t.one('SELECT approval_status, approved_at, approved_via, approval_recorded_by, file_id, notes FROM artwork WHERE id = 107'))
      .toEqual({ approval_status: 'changes_requested', approved_at: null, approved_via: null, approval_recorded_by: null, file_id: 107, notes: 'Wrong green' })
    expect(t.order(n).production_status).toBe('awaiting_artwork')
  })

  test('a stale version is refused with nothing written', async () => {
    const t = setupUploads()
    const before = t.footprint()
    const res = await t.json('PATCH', '/orders/2026-0007/artwork/107', { to: 'approved', via: 'email', expectedVersion: t.order('2026-0007').version + 1 })
    expect(res.status).toBe(409)
    expect(t.footprint()).toEqual(before)
    expect(t.one('SELECT approval_status FROM artwork WHERE id = 107')).toEqual({ approval_status: 'under_review' })
  })

  test("another order's artwork id is 404", async () => {
    const t = setupUploads()
    expect((await decide(t, '2026-0022', 107, { to: 'approved', via: 'email' })).status).toBe(404)
  })
})

describe('customer artwork', () => {
  test("every design across the customer's orders, and nobody else's", async () => {
    const t = setupUploads()
    const list = (await (await t.json('GET', '/customers/3/artwork')).json()) as ArtworkListResponse
    expect(list.designs.map((d) => [d.orderNumber, d.lineageId]).sort()).toEqual([['2026-0005', 105], ['2026-0005', 5], ['2026-0006', 6], ['2026-0009', 9], ['2026-0012', 12]])
    expect((await t.json('GET', '/customers/999/artwork')).status).toBe(404)
  })
})

test('401 on every artwork endpoint, with nothing written', async () => {
  const t = setupUploads()
  const before = t.footprint()
  for (const [method, path] of [['GET', '/orders/2026-0007/artwork'], ['PATCH', '/orders/2026-0007/artwork/107'], ['GET', '/customers/1/artwork']]) {
    expect((await t.json(method!, path!, { to: 'approved', via: 'email', expectedVersion: 0 }, false)).status, `${method} ${path}`).toBe(401)
  }
  expect((await t.upload('/orders/2026-0022/artwork?expectedVersion=0', PNG, 'image/png', { auth: false })).status).toBe(401)
  expect(t.footprint()).toEqual(before)
  expect(t.r2.calls).toEqual([])
})
