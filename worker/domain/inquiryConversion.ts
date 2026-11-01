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
/** Prices stay 0 until staff quote. "Help me choose" has no method yet, so it becomes 'other' with a note saying why. */
export function lineToItem(l: InquiryPayload['lines'][number]): ConvertedItem {
  const details = [l.personalization && `Personalization: ${l.personalization}`, l.material && `Material or item: ${l.material}`, l.notes].filter(Boolean)
  return {
    kind: 'product', product: productName(l.product), method: l.method === 'help' ? 'other' : l.method, garmentColor: l.color ?? null,
    sizes: l.sizes && Object.keys(l.sizes).length > 0 ? l.sizes : null, quantity: l.quantity, unitPriceCents: 0,
    description: details.length > 0 ? details.join('\n') : null,
    notes: l.method === 'help' ? 'Customer asked for help choosing the method.' : null,
  }
}

/** Retention (Arturo, 2026-11-01): spam counts from receipt, so reclassifying can't extend it. */
export const RETENTION_SPAM_DAYS = 30
export const RETENTION_UNCONVERTED_MONTHS = 12

export type ConversionFlags = { poRequired: boolean; artworkRequired: boolean; productionStatus: ProductionStatus }
