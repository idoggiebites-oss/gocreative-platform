// Settings > Pricing Management. Owner only: the server refuses everyone else, so hiding the link is a convenience and not the protection.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { business } from '@shared/business'
import { useI18n } from '@/i18n'
import { send, useMe, usePricing, useSend } from '@/lib/api'
import type { PricingConfig } from '../../worker/domain/pricing/engine'
import { BTN, BTN_PRIMARY, Check, Field, FormDialog, H2, INPUT, LINK, MutationError, SEC } from './form'
import ArtworkValidation from './ArtworkValidation'
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
// Enabling a service gives it no rates at all: a rate is only ever a number the owner typed. An incomplete service can't be saved or priced.
const PRICING = { mode: 'markup' as const } as unknown as { mode: 'markup'; rateBps: number }
const SKELETON: { [K in Service]: NonNullable<PricingConfig['services'][K]> } = {
  screen: { adjustmentBps: 0, pricing: PRICING, colorCostTiers: [] },
  embroidery: { adjustmentBps: 0, pricing: PRICING, complexityCostTiers: {} },
  dtg: { adjustmentBps: 0, pricing: PRICING, sizeCostTiers: {} },
  engraving: { adjustmentBps: 0, pricing: PRICING } as unknown as NonNullable<PricingConfig['services']['engraving']>,
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
          <Whole label={t.fromQty} value={row.minQty} onChange={(n) => onChange(list.map((x, j) => (j === i ? { ...x, minQty: n as number } : x)))} />
          <Money label={t.costDollars} value={row.costCents} onChange={(c) => onChange(list.map((x, j) => (j === i ? { ...x, costCents: c as number } : x)))} />
          <button type="button" className={BTN} onClick={() => { const next = list.filter((_, j) => j !== i); onChange(next.length ? next : undefined) }}>{t.removeTier}</button>
        </div>
      ))}
      <button type="button" className={`${BTN} self-start`} onClick={() => onChange([...list, { minQty: list.length ? list[list.length - 1].minQty + 1 : 1, costCents: undefined as unknown as number }])}>{t.addTier}</button>
    </fieldset>
  )
}

function FeeFields({ title, fee, onChange }: { title: string; fee: { sellCents: number; costCents: number } | undefined; onChange: (f: { sellCents: number; costCents: number } | undefined) => void }) {
  const t = useI18n().m.pricing
  const set = (k: 'sellCents' | 'costCents', c: number | undefined) => {
    const next = { sellCents: fee?.sellCents, costCents: fee?.costCents, [k]: c } as { sellCents: number; costCents: number }
    onChange(next.sellCents === undefined && next.costCents === undefined ? undefined : next) // half a fee stays invalid until both are entered
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
      <Percent label={t.rate} value={pricing.rateBps} onChange={(b) => onChange({ ...pricing, rateBps: b as number })} />
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
        <Money label={t.machine} value={s.machineCostPerMinuteCents} onChange={(v) => put({ ...s, machineCostPerMinuteCents: v })} />
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

// The engine's reasons are for the owner, in plain words. Spanish screens get them translated here; an unknown one shows as it is.
const REASONS_ES: [RegExp, string][] = [
  [/^no published pricing$/, 'no hay precios publicados'], [/^no lines$/, 'sin líneas'], [/^below the minimum margin$/, 'por debajo del margen mínimo'], [/^total over the review limit$/, 'total por encima del límite de revisión'],
  [/^amount too large to calculate exactly$/, 'monto demasiado grande para calcular con exactitud'], [/^the calculation came to nothing$/, 'el cálculo dio cero'], [/^line (\d+): invalid quantity$/, 'línea $1: cantidad no válida'],
  [/^line (\d+): quantity over the review limit$/, 'línea $1: cantidad por encima del límite de revisión'], [/^line (\d+): method needs a person \((.*)\)$/, 'línea $1: este método requiere a una persona ($2)'], [/^line (\d+): screen has no published rates$/, 'línea $1: serigrafía sin tarifas publicadas'], [/^line (\d+): embroidery has no published rates$/, 'línea $1: bordado sin tarifas publicadas'], [/^line (\d+): dtg has no published rates$/, 'línea $1: impresión directa sin tarifas publicadas'], [/^line (\d+): engraving has no published rates$/, 'línea $1: grabado sin tarifas publicadas'],
  [/^line (\d+): no cost for (.*)$/, 'línea $1: sin costo para $2'], [/^line (\d+): no decoration details$/, 'línea $1: sin detalles de decoración'], [/^line (\d+): quantity below the first screen tier$/, 'línea $1: cantidad por debajo del primer nivel'],
  [/^line (\d+): ink colors unknown$/, 'línea $1: colores de tinta desconocidos'], [/^line (\d+): more colors than the review limit$/, 'línea $1: más colores que el límite de revisión'], [/^line (\d+): print size unknown$/, 'línea $1: tamaño desconocido'],
  [/^line (\d+): no rate for small embroidery at this quantity$/, 'línea $1: sin tarifa de bordado pequeño para esta cantidad'], [/^line (\d+): no rate for medium embroidery at this quantity$/, 'línea $1: sin tarifa de bordado mediano para esta cantidad'], [/^line (\d+): no rate for large embroidery at this quantity$/, 'línea $1: sin tarifa de bordado grande para esta cantidad'],
  [/^line (\d+): no rate for small prints at this quantity$/, 'línea $1: sin tarifa de impresión pequeña para esta cantidad'], [/^line (\d+): no rate for medium prints at this quantity$/, 'línea $1: sin tarifa de impresión mediana para esta cantidad'], [/^line (\d+): no rate for large prints at this quantity$/, 'línea $1: sin tarifa de impresión grande para esta cantidad'],
  [/^line (\d+): no rate for small prints$/, 'línea $1: sin tarifa de impresión pequeña'], [/^line (\d+): no rate for medium prints$/, 'línea $1: sin tarifa de impresión mediana'], [/^line (\d+): no rate for large prints$/, 'línea $1: sin tarifa de impresión grande'], [/^line (\d+): embroidery complexity unknown$/, 'línea $1: complejidad del bordado desconocida'], [/^line (\d+): machine time unknown$/, 'línea $1: tiempo de máquina desconocido'],
]
function Result({ title, r }: { title: string; r: SimView | undefined }) {
  const { m, fmt, lang } = useI18n()
  const t = m.pricing
  const reason = (x: string) => {
    if (lang !== 'es') return x
    const hit = REASONS_ES.find(([re]) => re.test(x))
    return hit ? x.replace(hit[0], hit[1]) : x
  }
  if (!r) return null
  return (
    <div className="flex min-w-[220px] flex-1 flex-col gap-1 text-[13px]" data-testid={`sim-${title}`}>
      <h3 className="font-semibold">{title}</h3>
      <p><span className={MUTED}>{t.estimate}:</span> <strong>{r.totalCents === null ? t.manual : fmt.money(r.totalCents)}</strong></p>
      {r.costCents !== null && <p><span className={MUTED}>{t.internalCost}:</span> {fmt.money(r.costCents)}</p>}
      {r.marginBps !== null && <p><span className={MUTED}>{t.grossMargin}:</span> {(r.marginBps / 100).toFixed(2)}%</p>}
      {r.assumptions.length > 0 && <p><span className={MUTED}>{t.assumptions}:</span> {r.assumptions.join('; ')}</p>}
      {r.reasons.length > 0 && <p><span className={MUTED}>{t.warnings}:</span> {r.reasons.map(reason).join('; ')}</p>}
      {r.lines.length > 0 && <ul className="mt-1 list-none p-0">{r.lines.map((l, i) => <li key={i} className={MUTED}>{l.label}: {l.quantity} × {fmt.money(l.unitPriceCents)} = {fmt.money(l.lineTotalCents)}</li>)}</ul>}
    </div>
  )
}

function Simulator({ proposal, activeId, onCompared }: { proposal: PricingConfig; activeId: number | null; onCompared: (config: string | null) => void }) {
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
    const compared = JSON.stringify(proposal)
    notify.current(null) // until this answer arrives, what is on screen isn't this proposal
    const timer = setTimeout(() => {
      send<SimResult>('POST', '/pricing/simulate', { request: toRequest(lines), config: proposal })
        .then((r) => { if (live) { setResult(r); setFailed(false); notify.current(compared) } })
        .catch(() => { if (live) { setResult(null); setFailed(true) } })
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

function Editor({ state }: { state: PricingState }) {
  const { m, fmt } = useI18n()
  const t = m.pricing
  const base = state.draft?.config ?? state.active?.config ?? EMPTY
  const [config, setConfig] = useState<PricingConfig>(base)
  const seed = state.draft?.hash ?? state.active?.hash ?? ''
  const seedRef = useRef(seed)
  useEffect(() => { if (seedRef.current !== seed) { seedRef.current = seed; setConfig(state.draft?.config ?? state.active?.config ?? EMPTY) } }, [seed]) // eslint-disable-line react-hooks/exhaustive-deps
  const [compared, setCompared] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const form = useRef<HTMLDivElement>(null)
  const [publishing, setPublishing] = useState<{ id: number; hash: string } | null>(null) // exactly the draft the owner chose to publish
  const savedText = JSON.stringify(state.draft?.config ?? state.active?.config ?? EMPTY)
  const dirty = JSON.stringify(config) !== savedText
  const save = useSend<{ hash: string }, void>(() => send('PUT', '/pricing/draft', { config, expectedHash: state.draft?.hash ?? null }))
  const discard = useSend<unknown, void>(() => send('DELETE', '/pricing/draft', { hash: state.draft!.hash }))
  const publish = useSend<unknown, { id: number; hash: string }>((d) => send('POST', '/pricing/publish', { draftId: d.id, draftHash: d.hash, expectedActiveId: state.active?.id ?? null }))
  // A draft changed from another tab while the dialog is open: what was reviewed is no longer what would go out.
  useEffect(() => { if (publishing && state.draft?.hash !== publishing.hash) setPublishing(null) }, [publishing, state.draft?.hash])
  const restore = useSend<unknown, number>((id) => send('POST', `/pricing/versions/${id}/restore`, { expectedHash: state.draft?.hash ?? null }))
  const canPublish = Boolean(state.draft) && !dirty && compared === JSON.stringify(state.draft?.config ?? null) // only what the comparison on screen actually showed
  const trySave = () => {
    const bad = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
    setInvalid(Boolean(bad))
    if (bad) {
      bad.focus()
      return
    }
    save.mutate()
  }
  const setAdjustment = (s: Service, b: number | undefined) => {
    const rules = config.services[s]
    if (rules) setConfig({ ...config, services: { ...config.services, [s]: { ...rules, adjustmentBps: b as number } } })
  }
  return (
    <div ref={form} className="flex flex-col gap-5">
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

      <Simulator proposal={config} activeId={state.active?.id ?? null} onCompared={setCompared} />

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN} disabled={!dirty || save.isPending} onClick={trySave}>{t.saveDraft}</button>
          {state.draft && <button type="button" className={BTN} disabled={discard.isPending} onClick={() => discard.mutate(undefined)}>{t.discard}</button>}
          <button type="button" className={`${BTN} ${BTN_PRIMARY}`} disabled={!canPublish} onClick={() => setPublishing({ id: state.draft!.id, hash: state.draft!.hash })}>{t.publish}</button>
        </div>
        {!canPublish && <p className={MUTED}>{t.mustPreview}</p>}
        {invalid && <p role="alert" className="text-xs text-status-red-fg">{t.invalidField}</p>}
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
        <FormDialog open onOpenChange={() => setPublishing(null)} title={t.publishTitle} description={t.publishBody} submitLabel={t.publish} pending={publish.isPending} error={publish.error} disabled={!canPublish}
          onSubmit={() => { if (canPublish) publish.mutate(publishing, { onSuccess: () => setPublishing(null) }) }}>
          <span />
        </FormDialog>
      )}
    </div>
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
              <ArtworkValidation />
            </>
          )}
        </QueryBoundary>
      )}
    </div>
  )
}
