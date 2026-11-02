// Sample rates here are test numbers only. The engine has no prices of its own, and real ones come from the owner.
import { describe, expect, test } from 'vitest'
import { lineTotalCents, quoteTotals } from '../quotes'
import { calculateEstimate, customerView, pricingConfigSchema, type EstimateRequest, type PricingConfig } from './engine'

const CONFIG: PricingConfig = pricingConfigSchema.parse({
  productCostCents: { tshirts: 300, hats: 500, engraved: 400 },
  services: {
    screen: { adjustmentBps: 0, pricing: { mode: 'markup', rateBps: 5000 }, colorCostTiers: [{ minQty: 1, costCents: 100 }, { minQty: 24, costCents: 50 }], screenFee: { sellCents: 2000, costCents: 500 }, sizeCostCents: { small: 0, medium: 25, large: 50 }, maxColors: 6 },
    embroidery: { adjustmentBps: 0, pricing: { mode: 'margin', rateBps: 4000 }, complexityCostTiers: { small: [{ minQty: 1, costCents: 300 }], medium: [{ minQty: 1, costCents: 450 }] }, digitizingFee: { sellCents: 2500, costCents: 1000 } },
    dtg: { adjustmentBps: 0, pricing: { mode: 'markup', rateBps: 10000 }, sizeCostTiers: { medium: [{ minQty: 1, costCents: 200 }] } },
    engraving: { adjustmentBps: 0, pricing: { mode: 'markup', rateBps: 10000 }, machineCostPerMinuteCents: 50, setupFee: { sellCents: 1000, costCents: 200 } },
  },
})
const shirt = (quantity: number, colors: number | null = 2, extra = {}) => ({ product: 'tshirts', method: 'screen', quantity, decorations: [{ location: 'Front', size: 'medium' as const, colors }], ...extra })
const one = (line: EstimateRequest['lines'][number], cfg = CONFIG) => calculateEstimate(cfg, { lines: [line] })
const withScreen = (c: Partial<NonNullable<PricingConfig['services']['screen']>>): PricingConfig => ({ ...CONFIG, services: { ...CONFIG.services, screen: { ...CONFIG.services.screen!, ...c } } })

describe('screen printing', () => {
  test('a hand-checked example: every step visible', () => {
    // Unit cost: 300 blank + 2 colors × 100 + 25 medium = 525. Markup 50% = 787.5, rounded up to 788. Screen fee: 2 × $20.
    const r = one(shirt(10))
    expect(r.lines).toEqual([
      { kind: 'product', label: 'tshirts', quantity: 10, unitPriceCents: 788, lineTotalCents: 7880, lineIndex: 0 },
      { kind: 'charge', label: 'Screen setup, Front', quantity: 2, unitPriceCents: 2000, lineTotalCents: 4000, lineIndex: 0 },
    ])
    expect(r.totalCents).toBe(11880)
    expect(r.internal.costCents).toBe(5250 + 1000)
    expect(r.status).toBe('available')
  })
  test('quantity tiers: the highest tier reached applies, exactly at the boundary', () => {
    expect(one(shirt(23)).lines[0].unitPriceCents).toBe(788)
    expect(one(shirt(24)).lines[0].unitPriceCents).toBe(638) // 300 + 100 + 25 = 425 × 1.5 = 637.5, up to 638
  })
  test('tiers given out of order still pick correctly', () => {
    const cfg = withScreen({ colorCostTiers: [{ minQty: 24, costCents: 50 }, { minQty: 1, costCents: 100 }] })
    expect(one(shirt(30), cfg).lines[0].unitPriceCents).toBe(638)
  })
  test('each extra location adds its own colors and setup', () => {
    const r = one({ product: 'tshirts', method: 'screen', quantity: 10, decorations: [{ location: 'Front', size: 'medium', colors: 2 }, { location: 'Back', size: 'small', colors: 1 }] })
    expect(r.lines.map((l) => l.label)).toEqual(['tshirts', 'Screen setup, Front', 'Screen setup, Back'])
    expect(r.lines[0].unitPriceCents).toBe(Math.ceil((300 + 200 + 25 + 100 + 0) * 1.5))
  })
})

describe('the adjustment applies exactly once', () => {
  test('to the marked-up price and to fees, with exact arithmetic', () => {
    const r = one(shirt(10), withScreen({ adjustmentBps: 1000 }))
    expect(r.lines[0].unitPriceCents).toBe(867) // 525 × 1.5 × 1.1 = 866.25, up to 867
    expect(r.lines[1].unitPriceCents).toBe(2200)
    expect(r.internal.costCents).toBe(6250) // costs don't move
  })
  test('rounding happens once, from the exact fraction, not after each step', () => {
    // 3 × 1.5 × 1.01 = 4.545, up to 5. Rounding the markup first gives 5 × 1.01 = 5.05, up to 6, which would overcharge.
    const cfg: PricingConfig = { ...withScreen({ adjustmentBps: 100, colorCostTiers: [{ minQty: 1, costCents: 0 }], screenFee: { sellCents: 0, costCents: 0 }, sizeCostCents: { small: 0, medium: 0, large: 0 } }), productCostCents: { tshirts: 3 } }
    expect(one(shirt(1), cfg).lines[0].unitPriceCents).toBe(5)
  })
  test('a percentage change never stacks across published versions: rates stay unadjusted', () => {
    const base = one(shirt(10)).lines[0].unitPriceCents
    const v2 = one(shirt(10), withScreen({ adjustmentBps: 1000 })).lines[0].unitPriceCents
    const v3 = one(shirt(10), withScreen({ adjustmentBps: 1000 })).lines[0].unitPriceCents
    expect(v3).toBe(v2)
    expect(v2).toBeLessThan(Math.ceil(base * 1.1 * 1.1))
  })
  test('a negative adjustment lowers, a zero adjustment changes nothing', () => {
    expect(one(shirt(10), withScreen({ adjustmentBps: -1000 })).lines[0].unitPriceCents).toBe(709) // 708.75
    expect(one(shirt(10), withScreen({ adjustmentBps: 0 })).lines[0].unitPriceCents).toBe(788)
  })
  test('one service\'s adjustment leaves another alone', () => {
    const hat = { product: 'hats', method: 'embroidery', quantity: 1, decorations: [{ complexity: 'small' as const }] }
    expect(one(hat, withScreen({ adjustmentBps: 5000 })).lines[0].unitPriceCents).toBe(one(hat).lines[0].unitPriceCents)
  })
})

describe('margin mode and other services', () => {
  test('target margin is cost ÷ (1 − rate), so the margin is really that', () => {
    // Hat 500 + small 300 = 800. 40% margin: 800 ÷ 0.6 = 1333.33, up to 1334.
    const r = one({ product: 'hats', method: 'embroidery', quantity: 1, decorations: [{ complexity: 'small', location: 'Front' }] })
    expect(r.lines[0].unitPriceCents).toBe(1334)
    expect(r.lines[1]).toMatchObject({ label: 'Digitizing, Front', unitPriceCents: 2500 })
  })
  test('a margin of 100% or more is refused when saved', () => {
    expect(pricingConfigSchema.safeParse({ productCostCents: {}, services: { dtg: { adjustmentBps: 0, pricing: { mode: 'margin', rateBps: 10000 }, sizeCostTiers: {} } } }).success).toBe(false)
  })
  test('DTG by print size; engraving by machine time, for both laser methods', () => {
    expect(one({ product: 'tshirts', method: 'dtg', quantity: 2, decorations: [{ size: 'medium' }] }).lines[0].unitPriceCents).toBe(1000)
    for (const method of ['laser_engrave', 'laser_cut']) {
      const r = one({ product: 'engraved', method, quantity: 2, decorations: [{ machineMinutes: 3 }] })
      expect(r.lines[0].unitPriceCents).toBe(1100) // (400 + 150) × 2
      expect(r.lines[1]).toMatchObject({ label: 'Setup', quantity: 1, unitPriceCents: 1000 })
    }
  })
})

describe('minimums and margin floor', () => {
  const small = { ...CONFIG, services: { ...CONFIG.services, screen: { ...CONFIG.services.screen!, screenFee: { sellCents: 0, costCents: 0 } } } }
  test('the minimum order applies once per inquiry, not per line', () => {
    const r = calculateEstimate({ ...small, minOrderCents: 5000 }, { lines: [shirt(1), shirt(1)] })
    expect(r.lines.filter((l) => l.label === 'Minimum order')).toHaveLength(1)
    expect(r.totalCents).toBe(5000)
    const big = calculateEstimate({ ...small, minOrderCents: 5000 }, { lines: [shirt(10)] })
    expect(big.lines.some((l) => l.label === 'Minimum order')).toBe(false)
  })
  test('the margin floor is checked last, on the rounded totals including fee costs, and means manual review, not a changed price', () => {
    const r = one(shirt(10), { ...CONFIG, minMarginBps: 5000 })
    expect(r.status).toBe('manual_review_required')
    expect(r.totalCents).toBeNull()
    expect(r.reasons).toEqual(['below the minimum margin'])
    expect(one(shirt(10), { ...CONFIG, minMarginBps: 4000 }).status).toBe('available')
  })
})

describe('manual review, never an invented number', () => {
  test.each([
    ['no pricing published', null, shirt(10)],
    ['unknown ink colors', CONFIG, shirt(10, null)],
    ['zero colors', CONFIG, shirt(10, 0)],
    ['too many colors', CONFIG, shirt(10, 7)],
    ['help me choose', CONFIG, { ...shirt(10), method: 'help' }],
    ['a method with no model', CONFIG, { ...shirt(10), method: 'other' }],
    ['no cost for the product', CONFIG, { ...shirt(10), product: 'polos' }],
    ['a product named like an object property', CONFIG, { ...shirt(10), product: '__proto__' }],
    ['no decoration details', CONFIG, { ...shirt(10), decorations: [] }],
    ['no print size', CONFIG, { product: 'tshirts', method: 'screen', quantity: 10, decorations: [{ colors: 2 }] }],
    ['a size with no rate', CONFIG, { product: 'tshirts', method: 'dtg', quantity: 10, decorations: [{ size: 'large' as const }] }],
    ['no complexity', CONFIG, { product: 'hats', method: 'embroidery', quantity: 1, decorations: [{}] }],
    ['no machine time', CONFIG, { product: 'engraved', method: 'laser_engrave', quantity: 1, decorations: [{}] }],
    ['absurd machine time', CONFIG, { product: 'engraved', method: 'laser_engrave', quantity: 1, decorations: [{ machineMinutes: 99999 }] }],
    ['zero quantity', CONFIG, shirt(0)],
    ['fractional quantity', CONFIG, shirt(1.5)],
  ])('%s', (_name, cfg, line) => {
    const r = calculateEstimate(cfg, { lines: [line] })
    expect(r.status).toBe('manual_review_required')
    expect(r.totalCents).toBeNull()
    expect(r.lines).toEqual([])
    expect(r.reasons.length).toBeGreaterThan(0)
  })
  test('a service with no rates, and an empty first tier gap', () => {
    expect(one(shirt(10), { ...CONFIG, services: { dtg: CONFIG.services.dtg } }).status).toBe('manual_review_required')
    expect(one(shirt(5), withScreen({ colorCostTiers: [{ minQty: 12, costCents: 50 }] })).status).toBe('manual_review_required')
  })
  test('one unpriceable line means no figure at all, not a partial total', () => {
    const r = calculateEstimate(CONFIG, { lines: [shirt(10), { ...shirt(5), method: 'help' }] })
    expect(r.totalCents).toBeNull()
    expect(r.lines).toEqual([])
  })
  test('review limits on quantity and total', () => {
    expect(one(shirt(101), { ...CONFIG, review: { maxQuantity: 100 } }).status).toBe('manual_review_required')
    expect(one(shirt(10), { ...CONFIG, review: { maxTotalCents: 100 } }).status).toBe('manual_review_required')
  })
  test('a free config can\'t produce a $0 estimate', () => {
    const free: PricingConfig = { productCostCents: { tshirts: 0 }, services: { dtg: { adjustmentBps: 0, pricing: { mode: 'markup', rateBps: 0 }, sizeCostTiers: { medium: [{ minQty: 1, costCents: 0 }] } } } }
    expect(one({ product: 'tshirts', method: 'dtg', quantity: 1, decorations: [{ size: 'medium' }] }, free).status).toBe('manual_review_required')
  })
})

describe('assumptions and customer output', () => {
  test('stated assumptions make the status assumption-based, and repeat only once', () => {
    const r = calculateEstimate(CONFIG, { lines: [shirt(10, 2, { assumptions: ['White background not printed'] }), shirt(5, 2, { assumptions: ['White background not printed'] })] })
    expect(r.status).toBe('assumption_based')
    expect(r.assumptions).toEqual(['White background not printed'])
  })
  test('the customer view is an allowlist: no costs, margins, lines or reasons, whatever the result holds', () => {
    const view = customerView(one(shirt(10, 2, { assumptions: ['x'] })))
    expect(Object.keys(view).sort()).toEqual(['assumptions', 'status', 'totalCents'])
    const text = JSON.stringify(customerView(one(shirt(10, 7))))
    expect(text).not.toMatch(/cost|margin|limit|reason/i)
    expect(customerView(one(shirt(10, 7)))).toEqual({ status: 'manual_review_required', totalCents: null, assumptions: [] })
  })
})

describe('money stays exact', () => {
  test('every line maps exactly onto the quote code: integer unit price × quantity, and totals agree', () => {
    for (const q of [1, 3, 7, 23, 24, 99, 1000]) {
      const r = calculateEstimate(CONFIG, { lines: [shirt(q), { product: 'hats', method: 'embroidery', quantity: q, decorations: [{ complexity: 'medium' }] }] })
      const items = r.lines.map((l) => ({ kind: l.kind, quantity: l.quantity, unitPriceCents: l.unitPriceCents }))
      for (const [i, item] of items.entries()) expect(lineTotalCents(item as never)).toEqual({ ok: true, totalCents: r.lines[i].lineTotalCents })
      expect(quoteTotals(items as never)).toMatchObject({ totalCents: r.totalCents })
    }
  })
  test('rounding up adds less than one cent per unit over the exact figure', () => {
    for (let q = 1; q <= 50; q++) {
      const r = one(shirt(q), withScreen({ adjustmentBps: 137, screenFee: { sellCents: 0, costCents: 0 } }))
      const tierCost = q >= 24 ? 50 : 100
      const exact = (300 + 2 * tierCost + 25) * 1.5 * 1.0137 * q
      expect(r.lines[0].lineTotalCents).toBeGreaterThanOrEqual(Math.floor(exact))
      expect(r.lines[0].lineTotalCents - exact).toBeLessThan(q + 1e-6)
    }
  })
  test('large values stay exact and integer', () => {
    const r = one({ product: 'tshirts', method: 'dtg', quantity: 100000, decorations: [{ size: 'medium' }] }, { ...CONFIG, productCostCents: { tshirts: 99_999_999 } })
    expect(Number.isSafeInteger(r.totalCents)).toBe(true)
    expect(r.lines[0].unitPriceCents).toBe((99_999_999 + 200) * 2)
  })
  test('a blank fee or size schedule is manual review for every service that has one; a typed zero prices', () => {
    const { screenFee: _a, ...noFee } = CONFIG.services.screen!
    const { sizeCostCents: _b, ...noSizes } = CONFIG.services.screen!
    expect(one(shirt(10), withScreen(noFee)).reasons.join()).toMatch(/screen fee not set/)
    expect(one(shirt(10), withScreen(noSizes)).reasons.join()).toMatch(/print size charges not set/)
    const { digitizingFee: _c, ...noDigitizing } = CONFIG.services.embroidery!
    expect(one({ product: 'hats', method: 'embroidery', quantity: 5, decorations: [{ complexity: 'small' }] }, { ...CONFIG, services: { ...CONFIG.services, embroidery: noDigitizing } }).status).toBe('manual_review_required')
    const { setupFee: _d, ...noSetup } = CONFIG.services.engraving!
    expect(one({ product: 'engraved', method: 'laser_engrave', quantity: 5, decorations: [{ machineMinutes: 2 }] }, { ...CONFIG, services: { ...CONFIG.services, engraving: noSetup } }).status).toBe('manual_review_required')
    expect(one(shirt(10), withScreen({ screenFee: { sellCents: 0, costCents: 0 } })).status).toBe('available')
  })
  test('an amount beyond exact integers is manual review, never a figure that is off by cents', () => {
    const huge: PricingConfig = { ...CONFIG, productCostCents: { tshirts: 100_000_000 }, services: { screen: { adjustmentBps: 100000, pricing: { mode: 'markup', rateBps: 1000000 }, colorCostTiers: [{ minQty: 1, costCents: 99_999_999 }], screenFee: { sellCents: 0, costCents: 0 }, sizeCostCents: { small: 0, medium: 0, large: 0 } } } }
    const r = one({ product: 'tshirts', method: 'screen', quantity: 999999, decorations: [{ size: 'medium', colors: 20 }] }, huge)
    expect(r.status).toBe('manual_review_required')
    expect(r.reasons.join()).toMatch(/too large/)
    expect(r.totalCents).toBeNull()
  })
  test('the same config and request always give the same result', () => {
    expect(one(shirt(10))).toEqual(one(shirt(10)))
  })
})
