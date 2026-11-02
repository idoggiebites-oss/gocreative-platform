// Turns what a request says into what the engine prices. Pure. Colors never come from a person typing a number into a public form:
// customers can only send analysis reports, which are untrusted, and staff corrections are diffed here so every change needs a reason.
import { GARMENTS, PRINT_METHODS, defensibleColors, printLocationName, type ArtworkReport, type CustomerEstimate, type Garment, type InquiryLine } from '../../../shared/inquiry'
import type { EstimateDecoration, EstimateSeedLine } from '../../../shared/api'
import { calculateEstimate, manual, type DecorationInput, type EstimateRequest, type EstimateResult, type PricingConfig } from './engine'

export const MANUAL_VIEW: CustomerEstimate = { status: 'manual_review_required', totalCents: null, assumptions: [] }

// The customer sees these. Fixed text from here: nothing from a request can write into them.
const STANDARD_ITEM = 'Based on our standard item. A specific brand or style may change the price.'
const NO_BACKGROUND = 'We assumed the background of your artwork is not printed.'
const ON_WHITE = 'We assumed a white item, so any white in your artwork is the item itself and is not printed.'
const ON_LIGHT = 'We assumed a light-colored item that needs no underbase. White in your artwork is counted as an ink.'
const ART_REVIEW = 'Your artwork still needs a review by our team.'
const assumptionsFrom = (reports: (ArtworkReport | null | undefined)[], garment: Garment | null | undefined) => [
  STANDARD_ITEM,
  ...(garment === 'white' ? [ON_WHITE] : garment === 'light' ? [ON_LIGHT] : []),
  ...(reports.some((r) => r?.flags.includes('likely_background')) ? [NO_BACKGROUND] : []),
]

/** The whole calculation from what is stored: the request plus what stopped it. This, not the engine alone, is what replays an estimate. */
export const withBlockers = (config: PricingConfig | null, request: EstimateRequest, blockers: string[]): EstimateResult => {
  const result = calculateEstimate(config, request)
  return blockers.length > 0 ? manual([...blockers, ...result.reasons], result.assumptions) : result
}

/**
 * A customer's lines as the engine sees them. A print's color count comes only from a report on a file this session really uploaded; anything else is
 * unknown, so manual review. `reports` and `links` are stored with the estimate, so what it was based on stays on record.
 */
export function customerEstimate(config: PricingConfig | null, sent: InquiryLine[], reports: Record<string, ArtworkReport>, own: ReadonlySet<string>) {
  const blockers: string[] = []
  const used: Record<string, ArtworkReport> = {}
  const lines = sent.map((l) => (l.prints ? { ...l, prints: l.prints.map((p) => (p.artwork && !own.has(p.artwork) ? { location: p.location, ...(p.size ? { size: p.size } : {}) } : p)) } : l))
  const request: EstimateRequest = {
    lines: lines.map((l, i) => {
      const prints = PRINT_METHODS.includes(l.method) ? l.prints ?? [] : []
      const mine = prints.map((p) => (p.artwork && Object.hasOwn(reports, p.artwork) ? reports[p.artwork] : null))
      for (const p of prints) if (p.artwork && Object.hasOwn(reports, p.artwork)) used[p.artwork] = reports[p.artwork]
      if (prints.some((p) => !p.artwork)) blockers.push(`line ${i + 1}: a print has no artwork`)
      // Dark or unknown: whether an underbase is needed changes the price, and a person decides that. DTG on a dark item needs one too, and the rates don't price it.
      if ((l.method === 'screen' || l.method === 'dtg') && l.garment !== 'white' && l.garment !== 'light') blockers.push(`line ${i + 1}: garment color decides the underbase`)
      const decorations: DecorationInput[] = prints.map((p, j) => ({
        location: printLocationName(p.location), ...(p.size ? { size: p.size } : {}),
        ...(l.method === 'screen' ? { colors: defensibleColors(mine[j], l.garment) } : {}),
      }))
      return { product: l.product, method: l.method, quantity: l.quantity, decorations, assumptions: [...assumptionsFrom(mine, l.garment), ...(l.method === 'dtg' && mine.some((r) => !r || r.needsManualReview) ? [ART_REVIEW] : [])] }
    }),
  }
  return {
    lines, request, blockers, reports: used, reportsUsed: Object.keys(used).length > 0,
    links: lines.map((l) => (PRINT_METHODS.includes(l.method) ? l.prints ?? [] : []).map((p) => p.artwork ?? null)),
    result: withBlockers(config, request, blockers),
  }
}

type StoredInputs = { request?: EstimateRequest; links?: (string | number | null)[][] } | null
type PayloadLine = { product: string; method: string; quantity: number; garment?: unknown }
const garmentOf = (l: PayloadLine): Garment | null => (GARMENTS as readonly unknown[]).includes(l.garment) ? l.garment as Garment : null

/** Where a review starts: the latest estimate's facts on the request's own lines. Upload ids resolve through this inquiry's files only. */
export function reviewSeed(payload: PayloadLine[], latest: StoredInputs, uploads: ReadonlyMap<string, number>, productName: (slug: string) => string): EstimateSeedLine[] {
  return payload.map((l, i) => {
    const stored = latest?.request?.lines?.[i]
    return {
      product: productName(l.product), method: stored?.method ?? l.method, quantity: l.quantity, garment: garmentOf(l),
      decorations: (stored?.decorations ?? []).map((d, j) => {
        const link = latest?.links?.[i]?.[j] ?? null
        return {
          location: d.location ?? null, size: d.size ?? null, colors: d.colors ?? null, complexity: d.complexity ?? null, machineMinutes: d.machineMinutes ?? null,
          fileId: typeof link === 'number' ? link : link === null ? null : uploads.get(link) ?? null,
        }
      }),
    }
  })
}

const FIELDS = ['location', 'size', 'complexity', 'machineMinutes', 'fileId'] as const
const text = (v: unknown) => (v === null || v === undefined ? null : String(v))

/**
 * A staff member's facts against what they were looking at. Colors compare with the fresh analysis of the stored file when there is one: accepting
 * what the analysis found is not an override, and setting a number where it found none is. Product and quantity aren't taken from the browser at all.
 */
export function reviewedEstimate(config: PricingConfig | null, payload: PayloadLine[], seed: EstimateSeedLine[], sent: { method: string; decorations: EstimateDecoration[] }[], analyses: ReadonlyMap<number, ArtworkReport | null>) {
  const overrides: { field: string; original: string | null; replacement: string | null }[] = []
  const change = (field: string, original: unknown, replacement: unknown) => { if (text(original) !== text(replacement)) overrides.push({ field, original: text(original), replacement: text(replacement) }) }
  const request: EstimateRequest = {
    lines: payload.map((l, i) => {
      const s = sent[i]
      const was = seed[i]
      change(`line${i + 1}.method`, was?.method, s.method)
      const reports = s.decorations.map((d) => (d.fileId !== null ? analyses.get(d.fileId) ?? null : null))
      s.decorations.forEach((d, j) => {
        const before = was?.decorations[j]
        for (const f of FIELDS) change(`line${i + 1}.print${j + 1}.${f}`, before?.[f], d[f])
        if (s.method === 'screen') change(`line${i + 1}.print${j + 1}.colors`, d.fileId !== null ? defensibleColors(reports[j], garmentOf(l)) : before?.colors, d.colors)
      })
      for (let j = was?.decorations.length ?? 0; j < s.decorations.length; j++) change(`line${i + 1}.print${j + 1}`, null, 'added')
      for (let j = s.decorations.length; j < (was?.decorations.length ?? 0); j++) change(`line${i + 1}.print${j + 1}`, was!.decorations[j].location ?? 'print', null)
      return {
        product: l.product, method: s.method, quantity: l.quantity, assumptions: assumptionsFrom(reports, garmentOf(l)),
        decorations: s.decorations.map((d) => ({
          ...(d.location ? { location: d.location } : {}), ...(d.size ? { size: d.size } : {}), ...(s.method === 'screen' ? { colors: d.colors } : {}),
          ...(d.complexity ? { complexity: d.complexity } : {}), ...(d.machineMinutes !== null ? { machineMinutes: d.machineMinutes } : {}),
        })),
      }
    }),
  }
  return { request, overrides, links: sent.map((s) => s.decorations.map((d) => d.fileId)), result: calculateEstimate(config, request) }
}
