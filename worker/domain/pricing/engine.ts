// The one pricing calculation, used by the dashboard's simulator and the storefront alike. Pure: same config and same request, same result.
// It holds no prices. Every rate comes from the owner's published config, and any missing rate gives "manual review", never a made-up number.
// Money is integer cents and rates are basis points. Exact fractions are carried until a single round-up, so rounding never stacks.
import { z } from 'zod'

export const ENGINE_VERSION = 1

const cents = z.number().int().min(0).max(100_000_000)
const bps = z.number().int().min(-9000).max(100_000)
const tier = <T extends z.ZodRawShape>(shape: T) => z.array(z.object({ minQty: z.number().int().min(1).max(1_000_000), ...shape }).strict()).min(1).max(30)
const fee = z.object({ sellCents: cents, costCents: cents }).strict()
const SIZES = ['small', 'medium', 'large'] as const
const pricing = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('markup'), rateBps: z.number().int().min(0).max(1_000_000) }).strict(),
  z.object({ mode: z.literal('margin'), rateBps: z.number().int().min(0).max(9500) }).strict(), // 100% or more is impossible
])
const bySize = z.object({ small: cents.optional(), medium: cents.optional(), large: cents.optional() }).strict()

export const pricingConfigSchema = z.object({
  /** Cost of the blank item, per product slug. A product with no entry goes to manual review. */
  productCostCents: z.record(z.string().max(40), cents),
  services: z.object({
    screen: z.object({
      adjustmentBps: bps, pricing,
      /** Cost of printing one color at one location, by quantity. */
      colorCostTiers: tier({ costCents: cents }),
      screenFee: fee.optional(), // per color, per location
      sizeCostCents: bySize.optional(),
      maxColors: z.number().int().min(1).max(20).optional(),
    }).strict().optional(),
    embroidery: z.object({
      adjustmentBps: bps, pricing,
      /** Cost per piece per location, by complexity and quantity. */
      complexityCostTiers: z.object({ small: tier({ costCents: cents }).optional(), medium: tier({ costCents: cents }).optional(), large: tier({ costCents: cents }).optional() }).strict(),
      digitizingFee: fee.optional(), // per location
    }).strict().optional(),
    dtg: z.object({
      adjustmentBps: bps, pricing,
      /** Production cost per print, by size and quantity. */
      sizeCostTiers: z.object({ small: tier({ costCents: cents }).optional(), medium: tier({ costCents: cents }).optional(), large: tier({ costCents: cents }).optional() }).strict(),
    }).strict().optional(),
    engraving: z.object({
      adjustmentBps: bps, pricing,
      machineCostPerMinuteCents: cents,
      setupFee: fee.optional(), // per line
    }).strict().optional(),
  }).strict(),
  minOrderCents: cents.optional(),
  minMarginBps: z.number().int().min(0).max(9500).optional(),
  review: z.object({ maxQuantity: z.number().int().min(1).optional(), maxTotalCents: cents.optional() }).strict().optional(),
}).strict()
export type PricingConfig = z.infer<typeof pricingConfigSchema>
export type ServiceKey = keyof PricingConfig['services']

export type DecorationInput = {
  location?: string
  size?: (typeof SIZES)[number]
  /** Screen printing: ink colors at this location. */
  colors?: number | null
  /** Embroidery: complexity band. */
  complexity?: (typeof SIZES)[number]
  /** Engraving: machine minutes per piece. */
  machineMinutes?: number
}
export type EstimateLineInput = { product: string; method: string; quantity: number; decorations: DecorationInput[]; assumptions?: string[] }
export type EstimateRequest = { lines: EstimateLineInput[] }

/** A request as it arrives from outside the engine: bounded, so nobody can make it work unreasonably hard. */
export const estimateRequestSchema = z.object({
  lines: z.array(z.object({
    product: z.string().max(40), method: z.string().max(40), quantity: z.number().int().min(1).max(1_000_000),
    decorations: z.array(z.object({
      location: z.string().trim().max(60).optional(), size: z.enum(SIZES).optional(), colors: z.number().int().min(0).max(100).nullish(),
      complexity: z.enum(SIZES).optional(), machineMinutes: z.number().positive().max(1440).optional(),
    }).strict()).max(10),
    assumptions: z.array(z.string().max(200)).max(10).optional(),
  }).strict()).min(1).max(10),
}).strict()

export type EstimateStatus = 'available' | 'assumption_based' | 'manual_review_required'
export type PricedLine = { kind: 'product' | 'charge'; label: string; quantity: number; unitPriceCents: number; lineTotalCents: number; lineIndex: number | null }
export type InternalLine = { label: string; costCents: number; priceCents: number }
export type EstimateResult = {
  engineVersion: number
  status: EstimateStatus
  /** Null whenever status is manual review: never a partial or invented figure. */
  totalCents: number | null
  lines: PricedLine[]
  assumptions: string[]
  /** Why it went to manual review. Internal: these can name rules. */
  reasons: string[]
  internal: { costCents: number; marginBps: number | null; lines: InternalLine[] }
}

const SERVICE_OF: Record<string, ServiceKey | undefined> = { screen: 'screen', embroidery: 'embroidery', dtg: 'dtg', laser_engrave: 'engraving', laser_cut: 'engraving' }
const pickTier = <T extends { minQty: number }>(tiers: readonly T[], quantity: number): T | null =>
  [...tiers].sort((a, b) => b.minQty - a.minQty).find((t) => quantity >= t.minQty) ?? null

const B10K = 10_000n
/** The price of a cost, as an exact fraction: markup is cost × (1 + rate), target margin is cost ÷ (1 − rate), and the adjustment multiplies once. Rounded up to a whole cent only here. */
function priceOf(costCents: number, p: { mode: 'markup' | 'margin'; rateBps: number }, adjustmentBps: number) {
  const cost = BigInt(costCents)
  const num = (p.mode === 'markup' ? cost * (B10K + BigInt(p.rateBps)) : cost * B10K) * (B10K + BigInt(adjustmentBps))
  const den = (p.mode === 'markup' ? B10K : B10K - BigInt(p.rateBps)) * B10K
  return Number((num + den - 1n) / den) // the caller refuses an unsafe result
}
/** A selling fee takes the adjustment too, once, exactly as the plan says. It is not marked up: it is already a selling price. */
const feeOf = (sell: number, adjustmentBps: number) => priceOf(sell, { mode: 'markup', rateBps: 0 }, adjustmentBps)

type Priced = { unitCost: number; fees: { label: string; quantity: number; sell: number; cost: number }[] }
type LineOutcome = Priced | { manual: string }

function costLine(cfg: PricingConfig, service: ServiceKey, line: EstimateLineInput, blank: number): LineOutcome {
  const q = line.quantity
  if (line.decorations.length === 0) return { manual: 'no decoration details' }
  let unit = blank
  const fees: Priced['fees'] = []
  if (service === 'screen') {
    const s = cfg.services.screen!
    const t = pickTier(s.colorCostTiers, q)
    if (!t) return { manual: 'quantity below the first screen tier' }
    for (const d of line.decorations) {
      if (d.colors === null || d.colors === undefined || !Number.isInteger(d.colors) || d.colors < 1) return { manual: 'ink colors unknown' }
      if (s.maxColors !== undefined && d.colors > s.maxColors) return { manual: 'more colors than the review limit' }
      unit += t.costCents * d.colors
      if (s.sizeCostCents) {
        if (!d.size) return { manual: 'print size unknown' }
        const add = s.sizeCostCents[d.size]
        if (add === undefined) return { manual: `no rate for ${d.size} prints` }
        unit += add
      }
      if (s.screenFee) fees.push({ label: `Screen setup${d.location ? `, ${d.location}` : ''}`, quantity: d.colors, sell: s.screenFee.sellCents, cost: s.screenFee.costCents })
    }
  } else if (service === 'embroidery') {
    const s = cfg.services.embroidery!
    for (const d of line.decorations) {
      if (!d.complexity) return { manual: 'embroidery complexity unknown' }
      const tiers = s.complexityCostTiers[d.complexity]
      const t = tiers && pickTier(tiers, q)
      if (!t) return { manual: `no rate for ${d.complexity} embroidery at this quantity` }
      unit += t.costCents
      if (s.digitizingFee) fees.push({ label: `Digitizing${d.location ? `, ${d.location}` : ''}`, quantity: 1, sell: s.digitizingFee.sellCents, cost: s.digitizingFee.costCents })
    }
  } else if (service === 'dtg') {
    const s = cfg.services.dtg!
    for (const d of line.decorations) {
      if (!d.size) return { manual: 'print size unknown' }
      const tiers = s.sizeCostTiers[d.size]
      const t = tiers && pickTier(tiers, q)
      if (!t) return { manual: `no rate for ${d.size} prints at this quantity` }
      unit += t.costCents
    }
  } else {
    const s = cfg.services.engraving!
    for (const d of line.decorations) {
      if (d.machineMinutes === undefined || !Number.isFinite(d.machineMinutes) || d.machineMinutes <= 0 || d.machineMinutes > 1440) return { manual: 'machine time unknown' }
      unit += Math.ceil(s.machineCostPerMinuteCents * d.machineMinutes)
    }
    if (s.setupFee) fees.push({ label: 'Setup', quantity: 1, sell: s.setupFee.sellCents, cost: s.setupFee.costCents })
  }
  return { unitCost: unit, fees }
}

const manual = (reasons: string[], assumptions: string[] = []): EstimateResult => ({
  engineVersion: ENGINE_VERSION, status: 'manual_review_required', totalCents: null, lines: [], assumptions, reasons, internal: { costCents: 0, marginBps: null, lines: [] },
})

/** Order (plan §6): cost → markup or margin → the service adjustment once → round up per unit → per-inquiry minimum → margin check last, on the rounded totals. */
export function calculateEstimate(config: PricingConfig | null, request: EstimateRequest): EstimateResult {
  if (!config) return manual(['no published pricing'])
  if (request.lines.length === 0) return manual(['no lines'])
  const lines: PricedLine[] = []
  const internal: InternalLine[] = []
  const reasons: string[] = []
  const assumptions = new Set<string>()
  request.lines.forEach((line, lineIndex) => {
    for (const a of line.assumptions ?? []) assumptions.add(a)
    if (!Number.isInteger(line.quantity) || line.quantity < 1) return void reasons.push(`line ${lineIndex + 1}: invalid quantity`)
    if (config.review?.maxQuantity !== undefined && line.quantity > config.review.maxQuantity) return void reasons.push(`line ${lineIndex + 1}: quantity over the review limit`)
    const service = SERVICE_OF[line.method]
    if (!service) return void reasons.push(`line ${lineIndex + 1}: method needs a person (${line.method})`)
    const rules = config.services[service]
    if (!rules) return void reasons.push(`line ${lineIndex + 1}: ${service} has no published rates`)
    if (!Object.hasOwn(config.productCostCents, line.product)) return void reasons.push(`line ${lineIndex + 1}: no cost for ${line.product}`)
    const out = costLine(config, service, line, config.productCostCents[line.product])
    if ('manual' in out) return void reasons.push(`line ${lineIndex + 1}: ${out.manual}`)
    const unitPrice = priceOf(out.unitCost, rules.pricing, rules.adjustmentBps)
    lines.push({ kind: 'product', label: line.product, quantity: line.quantity, unitPriceCents: unitPrice, lineTotalCents: unitPrice * line.quantity, lineIndex })
    internal.push({ label: line.product, costCents: out.unitCost * line.quantity, priceCents: unitPrice * line.quantity })
    for (const f of out.fees) {
      const each = feeOf(f.sell, rules.adjustmentBps)
      lines.push({ kind: 'charge', label: f.label, quantity: f.quantity, unitPriceCents: each, lineTotalCents: each * f.quantity, lineIndex })
      internal.push({ label: f.label, costCents: f.cost * f.quantity, priceCents: each * f.quantity })
    }
  })
  // Past 2^53 a Number can't hold every cent, so an amount that large is a person's job, not a rounding error.
  if ([...lines.flatMap((l) => [l.unitPriceCents, l.lineTotalCents]), ...internal.map((l) => l.costCents)].some((n) => !Number.isSafeInteger(n))) reasons.push('amount too large to calculate exactly')
  // One line that can't be priced means no figure at all: a partial total would mislead.
  if (reasons.length > 0) return manual(reasons, [...assumptions])

  let total = lines.reduce((n, l) => n + l.lineTotalCents, 0)
  if (config.minOrderCents !== undefined && total < config.minOrderCents) {
    const gap = config.minOrderCents - total
    lines.push({ kind: 'charge', label: 'Minimum order', quantity: 1, unitPriceCents: gap, lineTotalCents: gap, lineIndex: null })
    internal.push({ label: 'Minimum order', costCents: 0, priceCents: gap })
    total = config.minOrderCents
  }
  const cost = internal.reduce((n, l) => n + l.costCents, 0)
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(cost)) return manual(['amount too large to calculate exactly'], [...assumptions])
  if (total <= 0) return manual(['the calculation came to nothing'], [...assumptions])
  const margin = (BigInt(total) - BigInt(cost)) * B10K
  const marginBps = Number(margin / BigInt(total))
  const floor = config.minMarginBps
  if (floor !== undefined && margin < BigInt(floor) * BigInt(total)) return manual(['below the minimum margin'], [...assumptions])
  if (config.review?.maxTotalCents !== undefined && total > config.review.maxTotalCents) return manual(['total over the review limit'], [...assumptions])
  return {
    engineVersion: ENGINE_VERSION, status: assumptions.size > 0 ? 'assumption_based' : 'available', totalCents: total, lines, assumptions: [...assumptions], reasons: [],
    internal: { costCents: cost, marginBps, lines: internal },
  }
}

/** What may leave the server for a customer: an explicit allowlist. Never costs, margins, rule names or per-rule breakdowns. */
export function customerView(r: EstimateResult) {
  return r.status === 'manual_review_required' || r.totalCents === null
    ? { status: 'manual_review_required' as const, totalCents: null, assumptions: [] as string[] }
    : { status: r.status, totalCents: r.totalCents, assumptions: r.assumptions }
}
