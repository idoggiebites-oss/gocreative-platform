// The public inquiry form's fields: an allowlist shared by the form and POST /api/public/submissions/submit. `.strict()`
// refuses anything else, so a browser can't send a customer id, status, price or note.
import { z } from 'zod'
import { business } from './business'
import { CUSTOMER_KINDS } from './enums'

const text = (max: number) => z.string().trim().min(1).max(max)
const METHOD_CHOICES = ['screen', 'embroidery', 'dtg', 'laser_engrave', 'laser_cut', 'other', 'help'] as const
export const FILE_PURPOSES = ['artwork', 'po'] as const
const products: readonly { slug: string; methods: readonly string[]; sized: boolean }[] = business.storefront.products

const line = z.object({
  product: z.string().max(40),
  method: z.enum(METHOD_CHOICES), // 'help' = "help me choose", always allowed
  quantity: z.number().int().min(1).max(100_000),
  sizes: z.record(z.string().max(8), z.number().int().min(0).max(100_000)).optional(),
  color: text(100).optional(),
  material: text(100).optional(),
  personalization: text(4000).optional(),
  notes: text(2000).optional(),
}).strict().superRefine((l, ctx) => {
  const product = products.find((p) => p.slug === l.product)
  if (!product) return ctx.addIssue({ code: 'custom', message: 'unknown product' })
  if (l.method !== 'help' && !product.methods.includes(l.method)) ctx.addIssue({ code: 'custom', message: 'method does not fit product' })
  if (l.sizes) {
    if (!product.sized) ctx.addIssue({ code: 'custom', message: 'product has no sizes' })
    if (Object.keys(l.sizes).some((s) => !(business.sizes as readonly string[]).includes(s))) ctx.addIssue({ code: 'custom', message: 'unknown size' })
    if (Object.values(l.sizes).reduce((a, b) => a + b, 0) !== l.quantity) ctx.addIssue({ code: 'custom', message: 'sizes must add up to quantity' })
  }
})

export const inquirySubmitSchema = z.object({
  customerKind: z.enum(CUSTOMER_KINDS),
  organization: text(200).optional(),
  contactName: text(200),
  contactEmail: z.email().max(254).optional(),
  contactPhone: z.string().trim().regex(/^[0-9+() .-]{7,30}$/).optional(),
  preferredContact: z.enum(['email', 'phone']).optional(),
  dueDate: z.iso.date().optional(),
  designHelp: z.boolean().optional(),
  description: text(4000).optional(), // placement, colors, special instructions, the event
  lines: z.array(line).min(1).max(10),
  website: z.string().max(200).optional(), // honeypot: hidden from people
}).strict().refine((d) => d.contactEmail || d.contactPhone, { message: 'email or phone required' })
  .refine((d) => !d.preferredContact || (d.preferredContact === 'email' ? d.contactEmail : d.contactPhone), { message: 'preferred contact missing' })

export type InquirySubmit = z.infer<typeof inquirySubmitSchema>
