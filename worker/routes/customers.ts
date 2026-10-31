import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../auth'
import type { ApiErrorCode, ContactResponse, CustomerDetailResponse, CustomerResponse, CustomersListResponse, NoteResponse } from '../../shared/api'
import { CUSTOMER_KINDS, PAYMENT_TERMS } from '../../shared/enums'
import { customerDefaults } from '../domain/customerDefaults'
import * as db from '../db/customers'

const id = z.string().regex(/^[1-9]\d{0,14}$/, 'invalid id').transform(Number)
const text = (max: number) => z.string().trim().max(max)
// Blank text means "none": '' becomes null so a cleared form field clears the column.
const nullable = (s: z.ZodType<string>) => z.union([s, z.null()]).transform((v) => (v === '' ? null : v))
const email = nullable(text(200).refine((v) => v === '' || z.string().email().safeParse(v).success, 'invalid email'))
// Lenient: digits plus the usual separators, optional extension. Not a numbering-plan check.
const phone = nullable(text(30).refine((v) => v === '' || /^\+?[\d\s().-]{5,}(\s*(x|ext\.?)\s*\d{1,6})?$/i.test(v), 'invalid phone'))
const name = text(200).min(1)

const createBody = z.object({
  name, kind: z.enum(CUSTOMER_KINDS), organization: nullable(text(200)).optional(), email: email.optional(), phone: phone.optional(),
  defaultPoRequired: z.boolean().optional(), defaultPaymentTerms: z.enum(PAYMENT_TERMS).optional(), internalNotes: nullable(text(5000)).optional(),
})
const patchBody = createBody.partial().extend({ expectedUpdatedAt: z.string().min(1) })
  .refine((b) => Object.keys(b).some((k) => k !== 'expectedUpdatedAt'), 'nothing to change')
const contactBody = z.object({ name, email: email.optional(), phone: phone.optional(), title: nullable(text(100)).optional(), isPrimary: z.boolean().optional() })
const contactPatch = contactBody.partial().refine((b) => Object.keys(b).length > 0, 'nothing to change')
const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(CUSTOMER_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const bad = (c: Context, e: z.ZodError) => c.json({ error: `Invalid request: ${e.issues[0]?.path.join('.') || 'input'} ${e.issues[0]?.message ?? ''}`.trim(), code: 'invalid_request' satisfies ApiErrorCode }, 400)
const notFound = (c: Context, what: string) => c.json({ error: `${what} not found`, code: 'not_found' satisfies ApiErrorCode }, 404)
const retry = (c: Context) => c.json({ error: 'Changed by someone else, reload and retry', code: 'conflict_retry' satisfies ApiErrorCode }, 409)
const body = (c: Context) => c.req.json().catch(() => null)

export function customerRoutes() {
  return new Hono<AppEnv>()
    .get('/customers', async (c) => {
      const q = listQuery.safeParse(c.req.query())
      if (!q.success) return bad(c, q.error)
      return c.json<CustomersListResponse>({ rows: await db.listCustomers(c.env.DB, q.data) })
    })
    .get('/customers/:id', async (c) => {
      const i = id.safeParse(c.req.param('id'))
      if (!i.success) return bad(c, i.error)
      const detail = await db.getCustomerDetail(c.env.DB, i.data)
      return detail ? c.json<CustomerDetailResponse>(detail) : notFound(c, 'Customer')
    })
    .post('/customers', async (c) => {
      const b = createBody.safeParse(await body(c))
      if (!b.success) return bad(c, b.error)
      const d = b.data
      const newId = await db.createCustomer(c.env.DB, c.get('user').id, {
        name: d.name, kind: d.kind, organization: d.organization ?? null, email: d.email ?? null, phone: d.phone ?? null, internalNotes: d.internalNotes ?? null,
        ...customerDefaults(d.kind), // the kind's defaults, overridden by whatever staff chose
        ...(d.defaultPoRequired === undefined ? {} : { defaultPoRequired: d.defaultPoRequired }),
        ...(d.defaultPaymentTerms === undefined ? {} : { defaultPaymentTerms: d.defaultPaymentTerms }),
      })
      return c.json<CustomerResponse>({ customer: (await db.getCustomer(c.env.DB, newId))! }, 201)
    })
    .patch('/customers/:id', async (c) => {
      const i = id.safeParse(c.req.param('id'))
      const b = patchBody.safeParse(await body(c))
      if (!i.success) return bad(c, i.error)
      if (!b.success) return bad(c, b.error)
      const current = await db.getCustomer(c.env.DB, i.data)
      if (!current) return notFound(c, 'Customer')
      const { expectedUpdatedAt, ...changes } = b.data
      if (current.updatedAt !== expectedUpdatedAt) return retry(c)
      if (!(await db.updateCustomer(c.env.DB, c.get('user').id, current, changes, expectedUpdatedAt))) return retry(c)
      return c.json<CustomerResponse>({ customer: (await db.getCustomer(c.env.DB, i.data))! })
    })
    .post('/customers/:id/contacts', async (c) => {
      const i = id.safeParse(c.req.param('id'))
      const b = contactBody.safeParse(await body(c))
      if (!i.success) return bad(c, i.error)
      if (!b.success) return bad(c, b.error)
      if (!(await db.getCustomer(c.env.DB, i.data))) return notFound(c, 'Customer')
      const { isPrimary, ...rest } = b.data
      const newId = await db.addContact(c.env.DB, c.get('user').id, i.data, { name: rest.name, email: rest.email ?? null, phone: rest.phone ?? null, title: rest.title ?? null }, isPrimary ?? false)
      return c.json<ContactResponse>({ contact: (await db.getContact(c.env.DB, i.data, newId))! }, 201)
    })
    .patch('/customers/:id/contacts/:contactId', async (c) => {
      const i = id.safeParse(c.req.param('id'))
      const k = id.safeParse(c.req.param('contactId'))
      const b = contactPatch.safeParse(await body(c))
      if (!i.success) return bad(c, i.error)
      if (!k.success) return bad(c, k.error)
      if (!b.success) return bad(c, b.error)
      const contact = await db.getContact(c.env.DB, i.data, k.data)
      if (!contact) return notFound(c, 'Contact')
      if (b.data.isPrimary && contact.archived) return c.json({ error: 'Archived contacts cannot be primary', code: 'contact_archived' satisfies ApiErrorCode }, 409)
      if (!(await db.updateContact(c.env.DB, c.get('user').id, i.data, contact, b.data))) return retry(c)
      return c.json<ContactResponse>({ contact: (await db.getContact(c.env.DB, i.data, k.data))! })
    })
    .post('/customers/:id/contacts/:contactId/:action{archive|unarchive}', async (c) => {
      const i = id.safeParse(c.req.param('id'))
      const k = id.safeParse(c.req.param('contactId'))
      if (!i.success) return bad(c, i.error)
      if (!k.success) return bad(c, k.error)
      if (!(await db.getContact(c.env.DB, i.data, k.data))) return notFound(c, 'Contact')
      const archive = c.req.param('action') === 'archive'
      if (!(await db.setContactArchived(c.env.DB, c.get('user').id, i.data, k.data, archive))) {
        return c.json({ error: `Contact is already ${archive ? 'archived' : 'active'}`, code: 'transition_not_allowed' satisfies ApiErrorCode }, 409)
      }
      return c.json<ContactResponse>({ contact: (await db.getContact(c.env.DB, i.data, k.data))! })
    })
    .post('/customers/:id/notes', async (c) => {
      const i = id.safeParse(c.req.param('id'))
      const b = z.object({ body: text(5000).min(1) }).safeParse(await body(c))
      if (!i.success) return bad(c, i.error)
      if (!b.success) return bad(c, b.error)
      if (!(await db.getCustomer(c.env.DB, i.data))) return notFound(c, 'Customer')
      return c.json<NoteResponse>({ note: await db.addNote(c.env.DB, c.get('user').id, i.data, b.data.body) }, 201)
    })
}
