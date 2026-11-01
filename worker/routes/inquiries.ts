// Staff review of public inquiries, behind Access and the JWT check like every /api/app route.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { ApiErrorCode, InquiryConvertResponse, InquiryDetailResponse } from '../../shared/api'
import { business } from '../../shared/business'
import { CUSTOMER_KINDS } from '../../shared/enums'
import { requireRole, type AppEnv } from '../auth'
import { customerDefaults } from '../domain/customerDefaults'
import { readiness } from '../domain/readiness'
import { conversionNote, lineToItem, parsePayload } from '../domain/inquiryConversion'
import * as db from '../db/inquiries'
import { getCustomerDefaults } from '../db/orders'
import { processClaimed } from '../inquiryDeletion'

const id = z.string().regex(/^[1-9]\d{0,14}$/).transform(Number)
const expected = z.object({ expectedVersion: z.number().int().min(0) })
const convertBody = expected.extend({
  title: z.string().trim().min(1).max(200),
  dueDate: z.iso.date().nullable(),
  artworkRequired: z.boolean(),
  customer: z.union([
    z.object({ existingId: z.number().int().positive(), contactId: z.number().int().positive().nullable() }).strict(),
    z.object({ new: z.object({ name: z.string().trim().min(1).max(200), kind: z.enum(CUSTOMER_KINDS), organization: z.string().trim().max(200).nullable() }).strict() }).strict(),
  ]),
}).strict()
const statusBody = expected.extend({ to: z.enum(['new', 'declined', 'spam']), reason: z.string().trim().max(1000).nullable().optional() }).strict()

const fail = (c: Context, status: 400 | 404 | 409, code: ApiErrorCode, error: string) => c.json({ error, code }, status)
const notFound = (c: Context) => fail(c, 404, 'not_found', 'Inquiry not found')
const stale = (c: Context) => fail(c, 409, 'conflict_retry', 'Changed by someone else, reload and retry')
const json = (c: Context) => c.req.json().catch(() => null)

/** The status a brand-new order starts in, the same as any order created by staff. */
const statusOf = (artworkRequired: boolean, poRequired: boolean) => readiness({
  state: 'active', quote: null, itemsRevision: 0, artworkRequired, designs: [], poRequired, latestPo: null, authorizedAt: null,
  materialsRequired: true, purchases: [], prepStatus: 'not_started',
}).preProductionStatus

export function inquiryRoutes() {
  return new Hono<AppEnv>()
    .get('/inquiries/:id', async (c) => {
      const i = id.safeParse(c.req.param('id'))
      if (!i.success) return notFound(c)
      const row = await db.getInquiry(c.env.DB, i.data)
      if (!row || row.deleting_at) return notFound(c)
      const payload = parsePayload(row.payload)
      const body: InquiryDetailResponse = {
        id: row.id, ref: row.ref, status: row.status, version: row.version, receivedAt: row.created_at,
        customerKind: row.customer_kind, organization: row.organization,
        contactName: row.contact_name, contactEmail: row.contact_email, contactPhone: row.contact_phone, preferredContact: row.preferred_contact,
        dueDate: row.due_date, declineReason: row.decline_reason, convertedAt: row.converted_at,
        orderNumber: await db.orderNumberOf(c.env.DB, row.order_id),
        lines: (payload?.lines ?? []).map((l) => ({
          product: business.storefront.products.find((p) => p.slug === l.product)?.name ?? l.product, method: l.method, quantity: l.quantity, sizes: l.sizes ?? null,
          color: l.color ?? null, material: l.material ?? null, personalization: l.personalization ?? null, notes: l.notes ?? null,
        })),
        description: payload?.description ?? null, designHelp: payload?.designHelp === true, convertible: payload !== null,
        files: (await db.listInquiryFiles(c.env.DB, row.id)).map((f) => ({ id: f.file_id, kind: f.kind, filename: f.filename, mime: f.mime, bytes: f.bytes })),
        matches: row.status === 'new' ? await db.matchCustomers(c.env.DB, row.contact_email, row.contact_phone) : [],
      }
      return c.json(body)
    })

    .post('/inquiries/:id/convert', async (c) => {
      const i = id.safeParse(c.req.param('id'))
      if (!i.success) return notFound(c)
      const b = convertBody.safeParse(await json(c))
      if (!b.success) return fail(c, 400, 'invalid_request', 'Invalid request')
      const row = await db.getInquiry(c.env.DB, i.data)
      if (!row || row.deleting_at) return notFound(c)
      // A repeat after a lost reply, or a second person: the one order, nothing new.
      const already = async () => {
        const fresh = await db.getInquiry(c.env.DB, i.data)
        const number = fresh?.status === 'converted' ? await db.orderNumberOf(c.env.DB, fresh.order_id) : null
        return number ? c.json<InquiryConvertResponse>({ number, alreadyConverted: true }) : null
      }
      const done = await already()
      if (done) return done
      if (row.status !== 'new') return fail(c, 409, 'inquiry_not_new', 'Only a new inquiry can be converted')
      if (row.version !== b.data.expectedVersion) return stale(c)
      const payload = parsePayload(row.payload)
      if (!payload || !row.contact_name) return fail(c, 409, 'inquiry_not_convertible', 'This inquiry has no request to convert')

      const d = b.data
      const files = await db.listInquiryFiles(c.env.DB, row.id)
      const hasPo = files.some((f) => f.kind === 'po')
      let customer: db.ConvertInput['customer']
      let defaults: { po: boolean; terms: ReturnType<typeof customerDefaults>['defaultPaymentTerms'] }
      if ('existingId' in d.customer) {
        const existing = await getCustomerDefaults(c.env.DB, d.customer.existingId)
        if (!existing) return notFound(c)
        customer = { existingId: existing.id, contactId: d.customer.contactId }
        defaults = { po: existing.default_po_required === 1, terms: existing.default_payment_terms }
      } else {
        const def = customerDefaults(d.customer.new.kind)
        customer = { new: { ...d.customer.new, defaultPoRequired: def.defaultPoRequired, defaultPaymentTerms: def.defaultPaymentTerms } }
        defaults = { po: def.defaultPoRequired, terms: def.defaultPaymentTerms }
      }
      const poRequired = defaults.po || hasPo
      const status = statusOf(d.artworkRequired, poRequired)
      const year = new Date().getUTCFullYear()
      const n = await db.convertInquiry(c.env.DB, {
        inquiryId: row.id, version: d.expectedVersion, actorId: c.get('user').id, year, title: d.title, dueDate: d.dueDate,
        customer, contact: { name: row.contact_name, email: row.contact_email, phone: row.contact_phone },
        poRequired, paymentTerms: defaults.terms, artworkRequired: d.artworkRequired, productionStatus: status,
        items: payload.lines.map(lineToItem), description: conversionNote(payload), files,
      })
      if (n === null) {
        const raced = await already()
        if (raced) return raced
        // Nothing was written. The customer or contact no longer fits, or the inquiry changed.
        const now = await db.getInquiry(c.env.DB, i.data)
        return now?.version === d.expectedVersion ? fail(c, 400, 'contact_not_for_customer', 'That contact is not available on this customer') : stale(c)
      }
      const fresh = await db.getInquiry(c.env.DB, i.data)
      const number = await db.orderNumberOf(c.env.DB, fresh?.order_id ?? null)
      return c.json<InquiryConvertResponse>({ number: number!, alreadyConverted: false }, 201)
    })

    .post('/inquiries/:id/status', async (c) => {
      const i = id.safeParse(c.req.param('id'))
      if (!i.success) return notFound(c)
      const b = statusBody.safeParse(await json(c))
      if (!b.success) return fail(c, 400, 'invalid_request', 'Invalid request')
      const ok = await db.setInquiryStatus(c.env.DB, { id: i.data, version: b.data.expectedVersion, actorId: c.get('user').id, to: b.data.to, reason: b.data.reason ?? null })
      return ok ? c.json({ ok: true }) : stale(c)
    })

    // Owner only, and never a converted inquiry. The journal is written before anything goes (worker/inquiryDeletion.ts).
    .delete('/inquiries/:id', requireRole('owner'), async (c) => {
      const i = id.safeParse(c.req.param('id'))
      if (!i.success) return notFound(c)
      const b = expected.safeParse(await json(c))
      if (!b.success) return fail(c, 400, 'invalid_request', 'Invalid request')
      if (!(await db.claimInquiry(c.env.DB, i.data, b.data.expectedVersion))) return stale(c)
      await processClaimed(c.env, 'owner', c.get('user').id)
      return c.json({ ok: true })
    })
}
