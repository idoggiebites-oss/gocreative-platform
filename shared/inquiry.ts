// The public inquiry form's fields: an allowlist shared by the form and POST /api/public/submissions/submit. `.strict()`
// refuses anything else, so a browser can't send a customer id, status, price or note.
import { z } from 'zod'
import { ANALYSIS_FLAGS, ANALYZER_VERSION } from './artworkAnalysis'
import { business } from './business'
import { CUSTOMER_KINDS } from './enums'

const text = (max: number) => z.string().trim().min(1).max(max)
const METHOD_CHOICES = ['screen', 'embroidery', 'dtg', 'laser_engrave', 'laser_cut', 'other', 'help'] as const
export const FILE_PURPOSES = ['artwork', 'po'] as const
const products: readonly { slug: string; methods: readonly string[]; sized: boolean }[] = business.storefront.products
export const PRINT_SIZES = ['small', 'medium', 'large'] as const
export const PRINT_METHODS: readonly string[] = ['screen', 'embroidery', 'dtg', 'help'] // what has a print location the customer can name; engraving needs a person
export const printLocationName = (slug: string) => (Object.hasOwn(business.storefront.printLocations, slug) ? business.storefront.printLocations[slug as keyof typeof business.storefront.printLocations] : slug)

/** Where one design goes. `artwork` is this session's upload id, checked by the server: a customer can't point at someone else's file. */
const printSchema = z.object({
  location: z.string().max(20).refine((l) => Object.hasOwn(business.storefront.printLocations, l)),
  size: z.enum(PRINT_SIZES).optional(),
  artwork: z.uuid().optional(),
}).strict()

/** What a browser says its analysis found. Untrusted whoever sends it: it can only ever produce an estimate labelled as reported. */
export const artworkReportSchema = z.object({
  analyzerVersion: z.number().int().min(1).max(1000),
  estimatedInkColors: z.number().int().min(0).max(100).nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  needsManualReview: z.boolean(),
  flags: z.array(z.enum(ANALYSIS_FLAGS)).max(ANALYSIS_FLAGS.length),
}).strict()
export type ArtworkReport = z.infer<typeof artworkReportSchema>
const reportsSchema = z.record(z.uuid(), artworkReportSchema).refine((r) => Object.keys(r).length <= 5)

/** The item's color group. A file can't tell us this, and it decides whether white prints and whether an underbase is needed. */
export const GARMENTS = ['white', 'light', 'dark', 'unsure'] as const
export type Garment = (typeof GARMENTS)[number]
// None of these leaves a count anyone can defend, so a price built on one would be invented. They go to a person.
const NO_COUNT: readonly string[] = ['gradient', 'photographic', 'too_little_flat_color', 'too_many_colors', 'partly_transparent', 'fully_transparent', 'too_large', 'too_small', 'thin_details', 'small_details_dropped', 'similar_shades', 'complex_separation']
/**
 * The ink count a report supports on this garment, or null when it supports none. An estimate from pixels, never a verified separation or a screen count.
 * A dark or unknown garment has no count: an underbase depends on the inks and the press, and only a person can decide it.
 */
export function defensibleColors(r: ArtworkReport | null | undefined, garment: Garment | null | undefined) {
  if (!r || r.analyzerVersion !== ANALYZER_VERSION || r.needsManualReview || r.confidence === 'low' || r.estimatedInkColors === null || r.estimatedInkColors < 1) return null
  if (r.flags.some((f) => NO_COUNT.includes(f))) return null
  if (garment !== 'white' && garment !== 'light') return null
  // A colored background may be part of the design, and there is no telling. Only white can be assumed away.
  if (r.flags.includes('likely_background') && !r.flags.includes('white_background')) return null
  // White shut inside the art is the garment on a white shirt. On any other color it must print, but it may or may not have been meant.
  if (r.flags.includes('background_inside') && garment !== 'white') return null
  const count = r.estimatedInkColors - (garment === 'white' && r.flags.includes('white_ink') ? 1 : 0)
  return count >= 1 ? count : null
}


export const inquiryLineSchema = z.object({
  product: z.string().max(40),
  method: z.enum(METHOD_CHOICES), // 'help' = "help me choose", always allowed
  quantity: z.number().int().min(1).max(100_000),
  sizes: z.record(z.string().max(8), z.number().int().min(0).max(100_000)).optional(),
  color: text(100).optional(),
  material: text(100).optional(),
  personalization: text(4000).optional(),
  notes: text(2000).optional(),
  prints: z.array(printSchema).max(4).optional(),
  garment: z.enum(GARMENTS).optional(),
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
  lines: z.array(inquiryLineSchema).min(1).max(10),
  reports: reportsSchema.optional(),
  website: z.string().max(200).optional(), // honeypot: hidden from people
}).strict().refine((d) => d.contactEmail || d.contactPhone, { message: 'email or phone required' })
  .refine((d) => !d.preferredContact || (d.preferredContact === 'email' ? d.contactEmail : d.contactPhone), { message: 'preferred contact missing' })

export type InquirySubmit = z.infer<typeof inquirySubmitSchema>
export type InquiryLine = z.infer<typeof inquiryLineSchema>

/** Asking for a figure before sending. Lines only: nothing about the customer, and never a price or a color count. */
export const estimatePreviewSchema = z.object({ lines: z.array(inquiryLineSchema).min(1).max(10), reports: reportsSchema.optional() }).strict()
/** All a customer ever sees of an estimate: one figure or none. */
export type CustomerEstimate = { status: 'available' | 'assumption_based' | 'manual_review_required'; totalCents: number | null; assumptions: string[] }
