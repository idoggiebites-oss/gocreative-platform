// Pure rules for turning an inquiry into an order. Nothing the customer sent is dropped: each line becomes one order item.
import { z } from 'zod'
import { business } from '../../shared/business'
import { printLocationName } from '../../shared/inquiry'
import { METHODS, type Method, type ProductionStatus } from '../../shared/enums'

// Reading a stored request is not validating a new one. The catalogue changes over time and later versions add fields, so a stored line
// needs only to be safe to show and convert: submit-time rules (shared/inquiry.ts) stay strict, and are deliberately not used here.
const storedText = z.string().nullish().transform((v) => v || undefined)
// Bad print details on an old row lose the print details, never the request.
const storedPrints = z.array(z.looseObject({ location: z.string().max(60), size: z.string().max(20).nullish(), artwork: z.string().max(60).nullish() })).max(20).nullish().catch(null)
const storedLine = z.looseObject({
  product: z.string().trim().min(1).max(200),
  method: z.string().min(1).max(40),
  quantity: z.number().int().min(1).max(1_000_000),
  sizes: z.record(z.string().max(20), z.number().int().min(0).max(1_000_000)).nullish().transform((v) => v ?? undefined),
  color: storedText, material: storedText, personalization: storedText, notes: storedText, prints: storedPrints,
})
const payloadSchema = z.looseObject({ lines: z.array(storedLine).min(1).max(200), designHelp: z.boolean().nullish(), description: z.string().nullish() })
export type InquiryPayload = z.infer<typeof payloadSchema>
/** The stored request, or null only for one with no usable lines at all (a row from before public intake, or corruption). */
export const parsePayload = (raw: string): InquiryPayload | null => {
  try {
    const p = payloadSchema.safeParse(JSON.parse(raw))
    // `spec` is set only by withVerifiedFacts. Whatever a stored row holds under that name is discarded, and can't make it unreadable.
    return p.success ? { ...p.data, lines: p.data.lines.map(({ spec: _spec, ...l }) => l) } : null
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
const NOTES_MAX = 2000
// Says on the order whose word it is. A count a browser reported is deliberately left out: only staff-reviewed facts can put an ink count on an order.
const printsText = (l: InquiryPayload['lines'][number]) => (l.prints?.length ? `Customer request, not verified: ${l.prints.map((p) => [printLocationName(p.location), p.size].filter(Boolean).join(', ')).join('; ')}. Ink colors not verified.` : 'Customer request, not verified.')
// A customer's own words can't claim a staff check, whatever they typed: only the spec line can say it.
const details = (l: InquiryPayload['lines'][number]) => [typeof l.spec === 'string' ? l.spec : printsText(l), ...[l.personalization && `Personalization: ${l.personalization}`, l.material && `Material or item: ${l.material}`, l.notes].map((x) => x && neutralized(x))].filter(Boolean).join('\n')
const knownMethod = (m: string): Method | null => METHODS.find((x) => x === m) ?? null
/** Sizes that don't add up to the quantity would make the item uneditable, so such a grid stays in the note rather than on the item. */
const usableSizes = (l: InquiryPayload['lines'][number]) => {
  if (!l.sizes || Object.keys(l.sizes).length === 0) return null
  if (Object.keys(l.sizes).some((k) => k.trim() !== k || k === '')) return null // the editor would reject these keys
  return Object.values(l.sizes).reduce((a, b) => a + b, 0) === l.quantity ? l.sizes : null
}

const noteFor = (l: InquiryPayload['lines'][number]) => [
  l.method === 'help' ? 'Customer asked for help choosing the method.' : !knownMethod(l.method) ? `Customer asked for: ${l.method}.` : null, // kept in words, never passed to the constrained column
  l.sizes && Object.keys(l.sizes).length > 0 && !usableSizes(l) ? `Sizes as sent: ${JSON.stringify(l.sizes)}` : null,
].filter(Boolean).join(' ')
const reviewedLines = z.array(z.object({ method: z.string().max(40), decorations: z.array(z.object({ location: z.string().optional(), size: z.string().optional(), colors: z.number().nullable().optional(), complexity: z.string().optional(), machineMinutes: z.number().optional() })) }))
export type ReviewedLine = z.infer<typeof reviewedLines>[number]
const VERIFIED = 'Staff verified at review'
export const UNVERIFIED_SINCE = 'Changed since review, not verified'
const ITEM_DESCRIPTION_MAX = 500
const neutralized = (text: string) => text.replace(new RegExp(VERIFIED.replace(/ /g, '\\s+'), 'gi'), UNVERIFIED_SINCE)
/** Keeps what the review said, as history, but stops it reading as a claim about what is on the item now. Also catches the label typed by hand. */
export const withoutVerification = (description: string | null) =>
  description && neutralized(description).slice(0, ITEM_DESCRIPTION_MAX)
// When, not just who: staff can edit the item afterwards, and this stays true of the review it describes.
const reviewedText = (l: ReviewedLine, who: string) => `${VERIFIED} (${who}): ${l.decorations.length === 0 ? 'no print details' : l.decorations.map((d) => [
  d.location, d.size, d.colors ? `${d.colors} ink color${d.colors === 1 ? '' : 's'}` : l.method === 'screen' ? 'ink colors not set' : null, d.complexity && `${d.complexity} complexity`, d.machineMinutes && `${d.machineMinutes} machine minutes per piece`,
].filter(Boolean).join(', ') || 'print').join('; ')}.`

/**
 * The request as the order should carry it. With a staff-reviewed estimate, its facts and method replace the customer's on the order, and say who stands behind them; without one, lines stay labelled unverified.
 * Facts only: an estimate's price is never read here, so items still convert at zero.
 */
export function withVerifiedFacts(p: InquiryPayload, reviewed: { lines: unknown; who: string; on: string } | null): InquiryPayload {
  const facts = reviewedLines.safeParse(reviewed?.lines)
  // A review that doesn't cover every line, or can't be read, verifies nothing.
  if (!reviewed || !facts.success || facts.data.length !== p.lines.length) return p
  return { ...p, lines: p.lines.map((l, i) => ({ ...l, method: facts.data[i].method, spec: reviewedText(facts.data[i], `${reviewed.who}, ${reviewed.on}`) })) }
}

const fits = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 28)}… (full text in order note)`)

/** Prices stay 0 until staff quote. "Help me choose" has no method yet, so it becomes 'other' with a note saying why. */
export function lineToItem(l: InquiryPayload['lines'][number]): ConvertedItem {
  const text = details(l)
  return {
    kind: 'product', product: productName(l.product), method: knownMethod(l.method) ?? 'other', garmentColor: l.color ? fits(neutralized(l.color), COLOR_MAX) : null,
    sizes: usableSizes(l), quantity: l.quantity, unitPriceCents: 0,
    description: text ? fits(text, DESCRIPTION_MAX) : null,
    notes: noteFor(l) ? fits(noteFor(l), NOTES_MAX) : null,
  }
}

/** The order's note: the project description, plus anything too long for its item, so nothing the customer wrote is lost. */
export function conversionNote(p: InquiryPayload): string | null {
  const long = p.lines.flatMap((l) => {
    const over = [
      details(l).length > DESCRIPTION_MAX ? details(l) : null,
      l.color && l.color.length > COLOR_MAX ? `Color: ${l.color}` : null,
      noteFor(l).length > NOTES_MAX ? noteFor(l) : null,
    ].filter(Boolean)
    return over.length > 0 ? [{ name: productName(l.product), text: over.join('\n') }] : []
  })
  const parts = [p.description, ...long.map((x) => `${x.name}:\n${x.text}`)].filter(Boolean)
  return parts.length > 0 ? parts.join('\n\n') : null
}

/** Retention (Arturo, 2026-11-01): spam counts from receipt, so reclassifying can't extend it. */
export const RETENTION_SPAM_DAYS = 30
export const RETENTION_UNCONVERTED_MONTHS = 12

export type ConversionFlags = { poRequired: boolean; artworkRequired: boolean; productionStatus: ProductionStatus }
