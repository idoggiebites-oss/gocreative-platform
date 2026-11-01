// Settings > Pricing Management. Owner only: the server refuses everyone else, so hiding the link is a convenience and not the protection.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { business } from '@shared/business'
import { useI18n } from '@/i18n'
import { send, useMe, usePricing, useSend } from '@/lib/api'
import { analyzeFile, type AnalyzerOutcome } from '@/lib/artworkAnalyzer'
import type { PricingConfig } from '../../worker/domain/pricing/engine'
import { BTN, BTN_PRIMARY, Check, Field, FormDialog, H2, INPUT, LINK, MutationError, SEC } from './form'
import QueryBoundary from './QueryBoundary'
import { CARD, Chip, MUTED, PAGE, TD, TH } from './ui'

type Service = keyof PricingConfig['services']
const SERVICES: Service[] = ['screen', 'embroidery', 'engraving', 'dtg']
const SIZES = ['small', 'medium', 'large'] as const
type Tier = { minQty: number; costCents: number }
type PricingState = {
  active: { id: number; hash: string; config: PricingConfig | null } | null
  draft: { id: number; hash: string; config: PricingConfig | null; rollbackOf: number | null; note: string | null } | null
  versions: { id: number; status: 'draft' | 'active' | 'retired'; note: string | null; rollbackOf: number | null; createdAt: string; publishedAt: string | null; publishedBy: string | null }[]
}
type SimView = { status: string; totalCents: number | null; assumptions: string[]; reasons: string[]; costCents: number | null; marginBps: number | null; lines: { label: string; quantity: number; unitPriceCents: number; lineTotalCents: number; kind: string }[] }
type SimResult = { current: SimView; proposed: SimView; differenceCents: number | null }

const EMPTY: PricingConfig = { productCostCents: {}, services: {} }
const PRICING = { mode: 'markup' as const, rateBps: 0 }
const SKELETON: { [K in Service]: NonNullable<PricingConfig['services'][K]> } = {
  screen: { adjustmentBps: 0, pricing: PRICING, colorCostTiers: [{ minQty: 1, costCents: 0 }] },
  embroidery: { adjustmentBps: 0, pricing: PRICING, complexityCostTiers: {} },
  dtg: { adjustmentBps: 0, pricing: PRICING, sizeCostTiers: {} },
  engraving: { adjustmentBps: 0, pricing: PRICING, machineCostPerMinuteCents: 0 },
}

// Text in, whole cents and basis points out. Blank means "not set", and never zero.
const toCents = (t: string) => { const v = t.trim(); return v === '' || !/^\d+(\.\d{1,2})?$/.test(v) ? null : Math.round(Number(v) * 100) }
const fromCents = (c: number | undefined | null) => (c === undefined || c === null ? '' : (c / 100).toFixed(2))
const toBps = (t: string) => { const v = t.trim(); return v === '' || !/^-?\d+(\.\d{1,2})?$/.test(v) ? null : Math.round(Number(v) * 100) }
const fromBps = (b: number | undefined | null) => (b === undefined || b === null ? '' : String(b / 100))

function Money({ label, value, onChange }: { label: ReactNode; value: number | undefined; onChange: (c: number | undefined) => void }) {
  const [text, setText] = useState(fromCents(value))
  useEffect(() => { if (toCents(text) !== (value ?? null)) setText(fromCents(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  const bad = text.trim() !== '' && toCents(text) === null
  return <Field label={label}><input className={INPUT} inputMode="decimal" aria-invalid={bad || undefined} value={text} onChange={(e) => { setText(e.target.value); const c = toCents(e.target.value); onChange(c ?? undefined) }} /></Field>
}
function Percent({ label, value, onChange }: { label: ReactNode; value: number | undefined; onChange: (b: number | undefined) => void }) {
  const [text, setText] = useState(fromBps(value))
  useEffect(() => { if (toBps(text) !== (value ?? null)) setText(fromBps(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  const bad = text.trim() !== '' && toBps(text) === null
  return <Field label={label}><input className={INPUT} inputMode="decimal" aria-invalid={bad || undefined} value={text} onChange={(e) => { setText(e.target.value); onChange(toBps(e.target.value) ?? undefined) }} /></Field>
}
function Whole({ label, value, onChange }: { label: ReactNode; value: number | undefined; onChange: (n: number | undefined) => void }) {
  return <Field label={label}><input className={INPUT} inputMode="numeric" value={value ?? ''} onChange={(e) => { const v = e.target.value.replace(/\D/g, ''); onChange(v === '' ? undefined : Number(v)) }} /></Field>
}

function Tiers({ title, tiers, onChange }: { title: string; tiers: Tier[] | undefined; onChange: (t: Tier[] | undefined) => void }) {
  const t = useI18n().m.pricing
  const list = tiers ?? []
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-[13px] font-medium">{title}</legend>
      {list.map((row, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <Whole label={t.fromQty} value={row.minQty} onChange={(n) => onChange(list.map((x, j) => (j === i ? { ...x, minQty: n ?? 1 } : x)))} />
          <Money label={t.costDollars} value={row.costCents} onChange={(c) => onChange(list.map((x, j) => (j === i ? { ...x, costCents: c ?? 0 } : x)))} />
          <button type="button" className={BTN} onClick={() => { const next = list.filter((_, j) => j !== i); onChange(next.length ? next : undefined) }}>{t.removeTier}</button>
        </div>
      ))}
      <button type="button" className={`${BTN} self-start`} onClick={() => onChange([...list, { minQty: list.length ? list[list.length - 1].minQty + 1 : 1, costCents: 0 }])}>{t.addTier}</button>
    </fieldset>
  )
}

function FeeFields({ title, fee, onChange }: { title: string; fee: { sellCents: number; costCents: number } | undefined; onChange: (f: { sellCents: number; costCents: number } | undefined) => void }) {
  const t = useI18n().m.pricing
  const set = (k: 'sellCents' | 'costCents', c: number | undefined) => {
    const next = { sellCents: fee?.sellCents ?? 0, costCents: fee?.costCents ?? 0, [k]: c ?? 0 }
    onChange(next.sellCents === 0 && next.costCents === 0 ? undefined : next)
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-[13px] font-medium">{title}</legend>
      <div className="flex flex-wrap gap-2"><Money label={t.sell} value={fee?.sellCents} onChange={(c) => set('sellCents', c)} /><Money label={t.yourCost} value={fee?.costCents} onChange={(c) => set('costCents', c)} /></div>
    </fieldset>
  )
}

function ModeFields({ pricing, onChange }: { pricing: { mode: 'markup' | 'margin'; rateBps: number }; onChange: (p: { mode: 'markup' | 'margin'; rateBps: number }) => void }) {
  const t = useI18n().m.pricing
  return (
    <div className="flex flex-wrap gap-2">
      <Field label={t.mode}><select className={INPUT} value={pricing.mode} onChange={(e) => onChange({ ...pricing, mode: e.target.value as 'markup' | 'margin' })}><option value="markup">{t.markup}</option><option value="margin">{t.margin}</option></select></Field>
      <Percent label={t.rate} value={pricing.rateBps} onChange={(b) => onChange({ ...pricing, rateBps: b ?? 0 })} />
    </div>
  )
}

function ServiceAdvanced({ service, c, set }: { service: Service; c: PricingConfig; set: (x: PricingConfig) => void }) {
  const t = useI18n().m.pricing
  const rules = c.services[service]
  const put = (next: unknown) => set({ ...c, services: { ...c.services, [service]: next } })
  const sizeName = (s: (typeof SIZES)[number]) => t[s]
  let body: ReactNode = null
  if (service === 'screen' && c.services.screen) {
    const s = c.services.screen
    body = (
      <>
        <Tiers title={t.colorTiers} tiers={s.colorCostTiers} onChange={(x) => put({ ...s, colorCostTiers: x ?? [] })} />
        <FeeFields title={t.screenFee} fee={s.screenFee} onChange={(f) => put({ ...s, screenFee: f })} />
        <fieldset className="flex flex-col gap-2"><legend className="text-[13px] font-medium">{t.sizeCharges}</legend>
          <div className="flex flex-wrap gap-2">{SIZES.map((z) => <Money key={z} label={sizeName(z)} value={s.sizeCostCents?.[z]} onChange={(v) => { const next = { ...s.sizeCostCents, [z]: v }; put({ ...s, sizeCostCents: Object.values(next).some((x) => x !== undefined) ? next : undefined }) }} />)}</div>
        </fieldset>
        <Whole label={t.maxColors} value={s.maxColors} onChange={(n) => put({ ...s, maxColors: n })} />
      </>
    )
  } else if (service === 'embroidery' && c.services.embroidery) {
    const s = c.services.embroidery
    body = (
      <>
        {SIZES.map((z) => <Tiers key={z} title={t.complexityTiers(sizeName(z))} tiers={s.complexityCostTiers[z]} onChange={(x) => put({ ...s, complexityCostTiers: { ...s.complexityCostTiers, [z]: x } })} />)}
        <FeeFields title={t.digitizing} fee={s.digitizingFee} onChange={(f) => put({ ...s, digitizingFee: f })} />
      </>
    )
  } else if (service === 'dtg' && c.services.dtg) {
    const s = c.services.dtg
    body = SIZES.map((z) => <Tiers key={z} title={t.sizeTiers(sizeName(z))} tiers={s.sizeCostTiers[z]} onChange={(x) => put({ ...s, sizeCostTiers: { ...s.sizeCostTiers, [z]: x } })} />)
  } else if (service === 'engraving' && c.services.engraving) {
    const s = c.services.engraving
    body = (
      <>
        <Money label={t.machine} value={s.machineCostPerMinuteCents} onChange={(v) => put({ ...s, machineCostPerMinuteCents: v ?? 0 })} />
        <FeeFields title={t.setup} fee={s.setupFee} onChange={(f) => put({ ...s, setupFee: f })} />
      </>
    )
  }
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-3" aria-label={t.services[service]}>
      <h3 className="text-[13px] font-semibold">{t.services[service]}</h3>
      <Check checked={Boolean(rules)} onChange={(on) => { const services = { ...c.services }; if (on) (services as Record<string, unknown>)[service] = SKELETON[service]; else delete services[service]; set({ ...c, services }) }}>{t.enableService}</Check>
      {rules && <ModeFields pricing={rules.pricing} onChange={(p) => put({ ...rules, pricing: p })} />}
      {rules && body}
    </section>
  )
}

type SampleLine = { product: string; method: string; quantity: number; location: string; size: string; colors: string; complexity: string; minutes: string }
const PRODUCTS = business.storefront.products as readonly { slug: string; name: string; methods: readonly string[] }[]
const newLine = (): SampleLine => ({ product: PRODUCTS[0].slug, method: 'screen', quantity: 24, location: 'Front', size: 'medium', colors: '2', complexity: 'medium', minutes: '' })
const toRequest = (lines: SampleLine[]) => ({
  lines: lines.map((l) => ({
    product: l.product, method: l.method, quantity: l.quantity,
    decorations: [{
      location: l.location.trim() || undefined, size: (l.size || undefined) as 'small' | undefined,
      ...(l.method === 'screen' ? { colors: l.colors === '' ? null : Number(l.colors) } : {}),
      ...(l.method === 'embroidery' ? { complexity: (l.complexity || undefined) as 'small' | undefined } : {}),
      ...(l.method.startsWith('laser') && l.minutes ? { machineMinutes: Number(l.minutes) } : {}),
    }],
  })),
})

function Result({ title, r }: { title: string; r: SimView | undefined }) {
  const { m, fmt } = useI18n()
  const t = m.pricing
  if (!r) return null
  return (
    <div className="flex min-w-[220px] flex-1 flex-col gap-1 text-[13px]" data-testid={`sim-${title}`}>
      <h3 className="font-semibold">{title}</h3>
      <p><span className={MUTED}>{t.estimate}:</span> <strong>{r.totalCents === null ? t.manual : fmt.money(r.totalCents)}</strong></p>
      {r.costCents !== null && <p><span className={MUTED}>{t.internalCost}:</span> {fmt.money(r.costCents)}</p>}
      {r.marginBps !== null && <p><span className={MUTED}>{t.grossMargin}:</span> {(r.marginBps / 100).toFixed(2)}%</p>}
      {r.assumptions.length > 0 && <p><span className={MUTED}>{t.assumptions}:</span> {r.assumptions.join('; ')}</p>}
      {r.reasons.length > 0 && <p><span className={MUTED}>{t.warnings}:</span> {r.reasons.join('; ')}</p>}
      {r.lines.length > 0 && <ul className="mt-1 list-none p-0">{r.lines.map((l, i) => <li key={i} className={MUTED}>{l.label}: {l.quantity} × {fmt.money(l.unitPriceCents)} = {fmt.money(l.lineTotalCents)}</li>)}</ul>}
    </div>
  )
}

function Simulator({ proposal, activeId, onCompared }: { proposal: PricingConfig; activeId: number | null; onCompared: () => void }) {
  const { m, fmt } = useI18n()
  const t = m.pricing
  const [lines, setLines] = useState<SampleLine[]>([newLine()])
  const [result, setResult] = useState<SimResult | null>(null)
  const [failed, setFailed] = useState(false)
  const key = useMemo(() => JSON.stringify([proposal, lines, activeId]), [proposal, lines, activeId]) // a newly published version changes the left-hand figures
  const notify = useRef(onCompared)
  notify.current = onCompared
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      send<SimResult>('POST', '/pricing/simulate', { request: toRequest(lines), config: proposal })
        .then((r) => { if (live) { setResult(r); setFailed(false); notify.current() } })
        .catch(() => { if (live) setFailed(true) })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const patch = (i: number, c: Partial<SampleLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...c } : l)))
  return (
    <section className={CARD} aria-labelledby="pricing-sim">
      <div className={SEC}><h2 id="pricing-sim" className={H2}>{t.simulator}</h2></div>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className={MUTED}>{t.simulatorHelp}</p>
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <Field label={t.product}><select className={INPUT} value={l.product} onChange={(e) => patch(i, { product: e.target.value })}>{PRODUCTS.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}</select></Field>
            <Field label={t.method}><select className={INPUT} value={l.method} onChange={(e) => patch(i, { method: e.target.value })}>{['screen', 'embroidery', 'dtg', 'laser_engrave', 'laser_cut'].map((x) => <option key={x} value={x}>{(m.labels.method as Record<string, string>)[x]}</option>)}</select></Field>
            <Whole label={t.quantity} value={l.quantity} onChange={(n) => patch(i, { quantity: n ?? 1 })} />
            <Field label={t.location}><input className={INPUT} value={l.location} maxLength={60} onChange={(e) => patch(i, { location: e.target.value })} /></Field>
            <Field label={t.size}><select className={INPUT} value={l.size} onChange={(e) => patch(i, { size: e.target.value })}><option value="">{t.noValue}</option>{SIZES.map((z) => <option key={z} value={z}>{t[z]}</option>)}</select></Field>
            {l.method === 'screen' && <Field label={t.colors}><input className={INPUT} inputMode="numeric" value={l.colors} onChange={(e) => patch(i, { colors: e.target.value.replace(/\D/g, '') })} /></Field>}
            {l.method === 'embroidery' && <Field label={t.complexity}><select className={INPUT} value={l.complexity} onChange={(e) => patch(i, { complexity: e.target.value })}><option value="">{t.noValue}</option>{SIZES.map((z) => <option key={z} value={z}>{t[z]}</option>)}</select></Field>}
            {l.method.startsWith('laser') && <Field label={t.minutes}><input className={INPUT} inputMode="decimal" value={l.minutes} onChange={(e) => patch(i, { minutes: e.target.value.replace(/[^\d.]/g, '') })} /></Field>}
            {lines.length > 1 && <button type="button" className={BTN} onClick={() => setLines(lines.filter((_, j) => j !== i))}>{t.remove}</button>}
          </div>
        ))}
        {lines.length < 10 && <button type="button" className={`${BTN} self-start`} onClick={() => setLines([...lines, newLine()])}>{t.addLine}</button>}
        {failed && <p role="alert" className="text-xs text-status-red-fg">{t.simFailed}</p>}
        {result && (
          <div className="flex flex-wrap gap-4 border-t border-border pt-3" aria-live="polite">
            <Result title={t.current} r={result.current} />
            <Result title={t.proposed} r={result.proposed} />
            <p className="text-[13px]"><span className={MUTED}>{t.difference}:</span> <strong>{result.differenceCents === null ? m.common.dash : `${result.differenceCents > 0 ? '+' : ''}${fmt.money(result.differenceCents)}`}</strong></p>
          </div>
        )}
      </div>
    </section>
  )
}

type CheckRow = { name: string; outcome: AnalyzerOutcome | null; known: string }
function ArtworkCheck() {
  const { m } = useI18n()
  const t = m.pricing
  const [rows, setRows] = useState<CheckRow[]>([])
  const add = (files: File[]) => {
    const start = rows.length
    setRows((r) => [...r, ...files.map((f) => ({ name: f.name, outcome: null, known: '' }))])
    files.reduce(async (prev, f, i) => { // one at a time, so a batch can't exhaust the browser
      await prev
      const outcome = await analyzeFile(f)
      setRows((r) => r.map((x, j) => (j === start + i ? { ...x, outcome } : x)))
    }, Promise.resolve())
  }
  const measured = rows.filter((r) => r.known !== '' && r.outcome)
  const counted = measured.filter((r) => r.outcome && 'analysis' in r.outcome && r.outcome.analysis.estimatedInkColors !== null)
  const inkOf = (r: CheckRow) => (r.outcome && 'analysis' in r.outcome ? r.outcome.analysis.estimatedInkColors : null)
  const exact = counted.filter((r) => inkOf(r) === Number(r.known)).length
  const near = counted.filter((r) => Math.abs((inkOf(r) ?? 99) - Number(r.known)) <= 1).length
  return (
    <section className={CARD} aria-labelledby="pricing-check">
      <div className={SEC}><h2 id="pricing-check" className={H2}>{t.check}</h2></div>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className={MUTED}>{t.checkHelp}</p>
        <label className={`${BTN} self-start cursor-pointer`}>{t.chooseFiles}<input type="file" multiple accept=".png,.jpg,.jpeg,.svg,.pdf" className="sr-only" onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = '' }} /></label>
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead><tr className="bg-header"><th className={TH}>{t.file}</th><th className={TH}>{t.known}</th><th className={TH}>{t.detected}</th><th className={TH}>{t.flagsCol}</th></tr></thead>
              <tbody>
                {rows.map((r, i) => {
                  const a = r.outcome && 'analysis' in r.outcome ? r.outcome.analysis : null
                  const flags = a ? a.flags : r.outcome && 'refused' in r.outcome ? [r.outcome.refused] : []
                  return (
                    <tr key={i}>
                      <td className={`${TD} whitespace-normal`}>{r.name}</td>
                      <td className={TD}><input aria-label={`${t.known}: ${r.name}`} className={`${INPUT} w-16`} inputMode="numeric" value={r.known} onChange={(e) => { const v = e.target.value.replace(/\D/g, ''); setRows(rows.map((x, j) => (j === i ? { ...x, known: v } : x))) }} /></td>
                      <td className={`${TD} num`}>{!r.outcome ? t.analyzing : a?.estimatedInkColors ?? t.manual}</td>
                      <td className={`${TD} whitespace-normal`}>{flags.map((f) => t.flags[f] ?? f).join(', ') || m.common.dash}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {measured.length > 0 && <p className="text-[13px]" data-testid="check-summary">{t.measured}: {measured.length}. {t.exact}: {exact}. {t.withinOne}: {near}. {t.refused}: {measured.length - counted.length}.</p>}
      </div>
    </section>
  )
}

function Editor({ state }: { state: PricingState }) {
  const { m, fmt } = useI18n()
  const t = m.pricing
  const base = state.draft?.config ?? state.active?.config ?? EMPTY
  const [config, setConfig] = useState<PricingConfig>(base)
  const seed = state.draft?.hash ?? state.active?.hash ?? ''
  const seedRef = useRef(seed)
  useEffect(() => { if (seedRef.current !== seed) { seedRef.current = seed; setConfig(state.draft?.config ?? state.active?.config ?? EMPTY) } }, [seed]) // eslint-disable-line react-hooks/exhaustive-deps
  const [compared, setCompared] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const savedText = JSON.stringify(state.draft?.config ?? state.active?.config ?? EMPTY)
  const dirty = JSON.stringify(config) !== savedText
  const save = useSend<{ hash: string }, void>(() => send('PUT', '/pricing/draft', { config, expectedHash: state.draft?.hash ?? null }))
  const discard = useSend<unknown, void>(() => send('DELETE', '/pricing/draft', { hash: state.draft!.hash }))
  const publish = useSend<unknown, void>(() => send('POST', '/pricing/publish', { draftId: state.draft!.id, draftHash: state.draft!.hash, expectedActiveId: state.active?.id ?? null }))
  const restore = useSend<unknown, number>((id) => send('POST', `/pricing/versions/${id}/restore`, { expectedHash: state.draft?.hash ?? null }))
  const canPublish = Boolean(state.draft) && !dirty && compared
  const setAdjustment = (s: Service, b: number | undefined) => {
    const rules = config.services[s]
    if (rules) setConfig({ ...config, services: { ...config.services, [s]: { ...rules, adjustmentBps: b ?? 0 } } })
  }
  return (
    <>
      <section className={CARD} aria-labelledby="pricing-simple">
        <div className={SEC}><h2 id="pricing-simple" className={H2}>{t.simple}</h2></div>
        <div className="flex flex-col gap-3 px-4 pb-4">
          <p className={MUTED}>{t.simpleHelp}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {SERVICES.map((s) => {
              const rules = config.services[s]
              return rules
                ? <Percent key={s} label={`${t.services[s]}: ${t.adjustment}`} value={rules.adjustmentBps} onChange={(b) => setAdjustment(s, b)} />
                : <div key={s} className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">{t.services[s]}</span><span className="text-[13px]">{t.noRates}</span></div>
            })}
          </div>
        </div>
      </section>

      <details className={CARD}>
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">{t.advanced}</summary>
        <div className="flex flex-col gap-4 px-4 pb-4">
          <section className="flex flex-col gap-2" aria-label={t.productCosts}>
            <h3 className="text-[13px] font-semibold">{t.productCosts}</h3>
            <p className={MUTED}>{t.productHelp}</p>
            <div className="flex flex-wrap gap-2">{PRODUCTS.map((p) => <Money key={p.slug} label={p.name} value={config.productCostCents[p.slug]} onChange={(c) => { const next = { ...config.productCostCents }; if (c === undefined) delete next[p.slug]; else next[p.slug] = c; setConfig({ ...config, productCostCents: next }) }} />)}</div>
          </section>
          {SERVICES.map((s) => <ServiceAdvanced key={s} service={s} c={config} set={setConfig} />)}
          <section className="flex flex-col gap-2 border-t border-border pt-3" aria-label={t.general}>
            <h3 className="text-[13px] font-semibold">{t.general}</h3>
            <p className={MUTED}>{t.blankOff}</p>
            <div className="flex flex-wrap gap-2">
              <Money label={t.minOrder} value={config.minOrderCents} onChange={(c) => setConfig({ ...config, minOrderCents: c })} />
              <Percent label={t.minMargin} value={config.minMarginBps} onChange={(b) => setConfig({ ...config, minMarginBps: b })} />
              <Whole label={t.maxQty} value={config.review?.maxQuantity} onChange={(n) => setConfig({ ...config, review: { ...config.review, maxQuantity: n } })} />
              <Money label={t.maxTotal} value={config.review?.maxTotalCents} onChange={(c) => setConfig({ ...config, review: { ...config.review, maxTotalCents: c } })} />
            </div>
          </section>
        </div>
      </details>

      <Simulator proposal={config} activeId={state.active?.id ?? null} onCompared={() => setCompared(true)} />

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN} disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{t.saveDraft}</button>
          {state.draft && <button type="button" className={BTN} disabled={discard.isPending} onClick={() => discard.mutate(undefined)}>{t.discard}</button>}
          <button type="button" className={`${BTN} ${BTN_PRIMARY}`} disabled={!canPublish} onClick={() => setPublishing(true)}>{t.publish}</button>
        </div>
        {!canPublish && <p className={MUTED}>{t.mustPreview}</p>}
        <MutationError error={save.error ?? discard.error ?? restore.error} />
      </section>

      <section className={CARD} aria-labelledby="pricing-history">
        <div className={SEC}><h2 id="pricing-history" className={H2}>{t.history}</h2></div>
        <div className="flex flex-col gap-2 px-4 pb-4">
          <p className={MUTED}>{t.restoreHelp}</p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead><tr className="bg-header"><th className={TH}>{t.version}</th><th className={TH}>{t.statuses.active}</th><th className={TH}>{t.publishedBy}</th><th className={TH}>{t.on}</th><th className={TH}>{t.note}</th><th className={TH} aria-label={t.restore} /></tr></thead>
              <tbody>
                {state.versions.map((v) => (
                  <tr key={v.id}>
                    <td className={`${TD} num`}>{v.id}</td>
                    <td className={TD}><Chip tone={v.status === 'active' ? 'green' : v.status === 'draft' ? 'amber' : 'gray'}>{t.statuses[v.status]}</Chip></td>
                    <td className={TD}>{v.publishedBy ?? m.common.dash}</td>
                    <td className={`${TD} num`}>{v.publishedAt ? fmt.date(v.publishedAt) : m.common.dash}</td>
                    <td className={`${TD} whitespace-normal`}>{v.rollbackOf ? t.rollbackOf(v.rollbackOf) : v.note ?? m.common.dash}</td>
                    <td className={TD}>{v.status !== 'draft' && <button type="button" className={BTN} onClick={() => restore.mutate(v.id)}>{t.restore}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {publishing && (
        <FormDialog open onOpenChange={() => setPublishing(false)} title={t.publishTitle} description={t.publishBody} submitLabel={t.publish} pending={publish.isPending} error={publish.error}
          onSubmit={() => publish.mutate(undefined, { onSuccess: () => setPublishing(false) })}>
          <span />
        </FormDialog>
      )}
    </>
  )
}

export default function PricingPage() {
  const { m } = useI18n()
  const t = m.pricing
  const me = useMe()
  const query = usePricing<PricingState>(me.data?.role === 'owner')
  return (
    <div className={PAGE}>
      <div className="flex flex-col gap-1">
        <Link to="/app/settings" className={`${LINK} text-[13px]`}>{t.back}</Link>
        <h1 tabIndex={-1} className="text-xl font-semibold">{t.title}</h1>
        <p className={MUTED}>{t.intro}</p>
      </div>
      {me.data && me.data.role !== 'owner' ? <p role="alert">{t.ownerOnly}</p> : (
        <QueryBoundary query={query}>
          {(d) => (
            <>
              <p className="text-[13px]">{d.active ? t.activeVersion(d.active.id) : t.noneActive}{d.draft ? ` ${t.draftOpen}` : ''}</p>
              <Editor state={d} />
              <ArtworkCheck />
            </>
          )}
        </QueryBoundary>
      )}
    </div>
  )
}
