// Pure rules for turning an inquiry into an order. Nothing the customer sent is dropped: each line becomes one order item.
import { z } from 'zod'
import { business } from '../../shared/business'
import { METHODS, type Method, type ProductionStatus } from '../../shared/enums'

// Reading a stored request is not validating a new one. The catalogue changes over time and later versions add fields, so a stored line
// needs only to be safe to show and convert: submit-time rules (shared/inquiry.ts) stay strict, and are deliberately not used here.
const storedText = z.string().nullish().transform((v) => v || undefined)
const storedLine = z.looseObject({
  product: z.string().min(1).max(200),
  method: z.string().min(1).max(40),
  quantity: z.number().int().min(1).max(1_000_000),
  sizes: z.record(z.string().max(20), z.number().int().min(0).max(1_000_000)).nullish().transform((v) => v ?? undefined),
  color: storedText, material: storedText, personalization: storedText, notes: storedText,
})
const payloadSchema = z.looseObject({ lines: z.array(storedLine).min(1), designHelp: z.boolean().nullish(), description: z.string().nullish() })
export type InquiryPayload = z.infer<typeof payloadSchema>
/** The stored request, or null only for one with no usable lines at all (a row from before public intake, or corruption). */
export const parsePayload = (raw: string): InquiryPayload | null => {
  try {
    const p = payloadSchema.safeParse(JSON.parse(raw))
    return p.success ? p.data : null
  } catch {
    return null
  }
}

const productName = (slug: string) => business.storefront.products.find((p) => p.slug === slug)?.name ?? slug

export type ConvertedItem = {
  kind: 'product'; description: string | null; product: string; garmentColor: string | null; method: Method
  sizes: Record<string, number> | null; quantity: number; unitPriceCents: 0; notes: string | null
}
// The limits of the ordinary order editor. A converted item must stay editable, so longer text moves to the order's note in full.
const DESCRIPTION_MAX = 500
const COLOR_MAX = 100
const details = (l: InquiryPayload['lines'][number]) => [l.personalization && `Personalization: ${l.personalization}`, l.material && `Material or item: ${l.material}`, l.notes].filter(Boolean).join('\n')
const knownMethod = (m: string): Method | null => METHODS.find((x) => x === m) ?? null
/** Sizes that don't add up to the quantity would make the item uneditable, so such a grid stays in the note rather than on the item. */
const usableSizes = (l: InquiryPayload['lines'][number]) => {
  if (!l.sizes || Object.keys(l.sizes).length === 0) return null
  return Object.values(l.sizes).reduce((a, b) => a + b, 0) === l.quantity ? l.sizes : null
}

/** Prices stay 0 until staff quote. "Help me choose" has no method yet, so it becomes 'other' with a note saying why. */
export function lineToItem(l: InquiryPayload['lines'][number]): ConvertedItem {
  const text = details(l)
  return {
    kind: 'product', product: productName(l.product), method: knownMethod(l.method) ?? 'other', garmentColor: l.color ? l.color.slice(0, COLOR_MAX) : null,
    sizes: usableSizes(l), quantity: l.quantity, unitPriceCents: 0,
    description: !text ? null : text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 28)}… (full text in order note)`,
    // A method no longer in the list is kept in words, and never passed to the database's constrained column.
    notes: [
      l.method === 'help' ? 'Customer asked for help choosing the method.' : !knownMethod(l.method) ? `Customer asked for: ${l.method}.` : null,
      l.sizes && Object.keys(l.sizes).length > 0 && !usableSizes(l) ? `Sizes as sent: ${JSON.stringify(l.sizes)}` : null,
    ].filter(Boolean).join(' ') || null,
  }
}

/** The order's note: the project description, plus any line details too long for the item, so nothing the customer wrote is lost. */
export function conversionNote(p: InquiryPayload): string | null {
  const long = p.lines.map((l) => ({ name: productName(l.product), text: details(l) })).filter((x) => x.text.length > DESCRIPTION_MAX)
  const parts = [p.description, ...long.map((x) => `${x.name}:\n${x.text}`)].filter(Boolean)
  return parts.length > 0 ? parts.join('\n\n') : null
}

/** Retention (Arturo, 2026-11-01): spam counts from receipt, so reclassifying can't extend it. */
export const RETENTION_SPAM_DAYS = 30
export const RETENTION_UNCONVERTED_MONTHS = 12

export type ConversionFlags = { poRequired: boolean; artworkRequired: boolean; productionStatus: ProductionStatus }
