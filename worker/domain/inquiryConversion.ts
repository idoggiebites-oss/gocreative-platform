// Pure rules for turning an inquiry into an order. Nothing the customer sent is dropped: each line becomes one order item.
import { z } from 'zod'
import { business } from '../../shared/business'
import type { Method, ProductionStatus } from '../../shared/enums'
import { inquiryLineSchema } from '../../shared/inquiry'

const payloadSchema = z.object({ lines: z.array(inquiryLineSchema).min(1), designHelp: z.boolean().optional(), description: z.string().nullable().optional() })
export type InquiryPayload = z.infer<typeof payloadSchema>
/** The stored request, or null for one that can't be converted (only ever a row from before public intake). */
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

/** Prices stay 0 until staff quote. "Help me choose" has no method yet, so it becomes 'other' with a note saying why. */
export function lineToItem(l: InquiryPayload['lines'][number]): ConvertedItem {
  const text = details(l)
  return {
    kind: 'product', product: productName(l.product), method: l.method === 'help' ? 'other' : l.method, garmentColor: l.color ? l.color.slice(0, COLOR_MAX) : null,
    sizes: l.sizes && Object.keys(l.sizes).length > 0 ? l.sizes : null, quantity: l.quantity, unitPriceCents: 0,
    description: !text ? null : text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 28)}… (full text in order note)`,
    notes: l.method === 'help' ? 'Customer asked for help choosing the method.' : null,
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
