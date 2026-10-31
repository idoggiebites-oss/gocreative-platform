import { Plus } from 'lucide-react'
import type { ItemInput, OrderItem } from '@shared/api'
import { business } from '@shared/business'
import { METHODS, type ItemKind, type Method } from '@shared/enums'
import { parseDollarsToCents, formatCentsPlain } from '@shared/money'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { quoteTotals } from '../../worker/domain/quotes'
import { BTN, BTN_SM, Check, Field, INPUT, LBL } from './form'
import { CARD } from './ui'

/** One editable line. Numbers stay text while typing so a half-typed price is never rewritten. */
export type Row = {
  key: string
  id?: number
  kind: ItemKind
  description: string
  product: string
  method: Method | ''
  garmentColor: string
  useSizes: boolean
  sizes: Record<string, string>
  quantity: string
  unitPrice: string
  notes: string
}

let n = 0
export const newRow = (kind: ItemKind = 'product'): Row => ({
  key: `r${++n}`, kind, description: '', product: '', method: kind === 'product' ? 'screen' : '', garmentColor: '',
  useSizes: kind === 'product', sizes: {}, quantity: kind === 'product' ? '' : '1', unitPrice: '', notes: '',
})

export function rowsFromItems(items: (OrderItem & { notes: string | null })[]): Row[] {
  return items.map((i) => ({
    key: `r${++n}`, id: i.id, kind: i.kind, description: i.description ?? '', product: i.product ?? '', method: i.method ?? '',
    garmentColor: i.garmentColor ?? '', useSizes: i.sizes !== null, sizes: Object.fromEntries(Object.entries(i.sizes ?? {}).map(([k, v]) => [k, String(v)])),
    quantity: String(i.quantity), unitPrice: formatCentsPlain(i.unitPriceCents), notes: i.notes ?? '',
  }))
}

const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : s.trim() === '' ? 0 : NaN)
const sizeEntries = (r: Row) => Object.entries(r.sizes).map(([k, v]) => [k, int(v)] as const)
/** The row's quantity: the size grid's sum when sizes are used, else the number typed. */
export const rowQuantity = (r: Row): number => (r.useSizes ? sizeEntries(r).reduce((s, [, v]) => s + v, 0) : int(r.quantity))

export type RowIssue = 'product' | 'method' | 'quantity' | 'price' | 'description'
/** What is wrong with one row, in place (the form shows each as text under the row). */
export function rowIssues(r: Row): RowIssue[] {
  const out: RowIssue[] = []
  if (r.kind === 'product') {
    if (!r.product.trim()) out.push('product')
    if (!r.method) out.push('method')
  } else if (!r.description.trim()) out.push('description')
  const q = rowQuantity(r)
  if (!Number.isSafeInteger(q) || q < 1 || (r.useSizes && sizeEntries(r).some(([, v]) => !Number.isSafeInteger(v)))) out.push('quantity')
  if (parseDollarsToCents(r.unitPrice) === null) out.push('price')
  return out
}

export function toInputs(rows: Row[]): ItemInput[] {
  return rows.map((r) => ({
    ...(r.id === undefined ? {} : { id: r.id }),
    kind: r.kind,
    description: r.description.trim() || null,
    product: r.kind === 'product' ? r.product.trim() : null,
    garmentColor: r.kind === 'product' ? r.garmentColor.trim() || null : null,
    method: r.kind === 'product' ? (r.method || null) : null,
    sizes: r.kind === 'product' && r.useSizes ? Object.fromEntries(sizeEntries(r).filter(([, v]) => v > 0)) : null,
    quantity: rowQuantity(r),
    unitPriceCents: parseDollarsToCents(r.unitPrice) ?? 0,
    notes: r.notes.trim() || null,
  }))
}

/** Totals via the same pure rules the server uses. null while any row is unfinished. */
export function totalsOf(rows: Row[]) {
  if (rows.some((r) => rowIssues(r).some((i) => i === 'quantity' || i === 'price'))) return null
  const t = quoteTotals(toInputs(rows))
  return t.ok ? t : { error: t.error }
}

const lineCents = (r: Row) => {
  const price = parseDollarsToCents(r.unitPrice)
  const q = rowQuantity(r)
  return price === null || !Number.isSafeInteger(q) || q < 1 ? null : (r.kind === 'discount' ? -1 : 1) * q * price
}

export function ItemsEditor({ rows, onChange, showIssues, framed = true }: { rows: Row[]; onChange: (r: Row[]) => void; showIssues: boolean; framed?: boolean }) {
  const { m, fmt } = useI18n()
  const t = m.items
  const set = (key: string, patch: Partial<Row>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const totals = totalsOf(rows)
  const pieces = rows.filter((r) => r.kind === 'product').reduce((s, r) => s + (Number.isSafeInteger(rowQuantity(r)) ? rowQuantity(r) : 0), 0)
  return (
    <div className={cn(framed && CARD)}>
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2.5">
        <h2 className="text-sm font-semibold">{t.title}</h2>
        <span className={LBL}>{t.hint}</span>
      </div>
      {rows.length === 0 && <p className="border-t border-secondary px-4 py-6 text-center text-[13px] text-muted-foreground">{t.empty}</p>}
      {rows.map((r, idx) => {
        const issues = showIssues ? rowIssues(r) : []
        const columns = [...business.sizes, ...Object.keys(r.sizes).filter((k) => !(business.sizes as readonly string[]).includes(k))]
        const line = lineCents(r)
        const bad = (i: RowIssue) => (issues.includes(i) ? true : undefined)
        const number = idx + 1
        return (
          <div key={r.key} role="group" aria-label={t.rowLabel(number)} className="flex flex-col gap-3 border-t border-secondary px-4 py-3.5">
            <div className="flex flex-wrap gap-3">
              <Field label={t.kind} className="w-[120px] flex-none">
                <select
                  className={INPUT} value={r.kind}
                  onChange={(e) => {
                    const kind = e.target.value as ItemKind
                    set(r.key, kind === 'product' ? { kind, method: r.method || 'screen', useSizes: true } : { kind, useSizes: false, quantity: r.quantity || '1' })
                  }}
                >
                  {(['product', 'charge', 'discount'] as const).map((k) => <option key={k} value={k}>{m.labels.itemKind[k]}</option>)}
                </select>
              </Field>
              {r.kind === 'product' ? (
                <>
                  <Field label={t.product} className="flex-[2_1_220px]"><input className={INPUT} value={r.product} aria-invalid={bad('product')} onChange={(e) => set(r.key, { product: e.target.value })} /></Field>
                  <Field label={t.method} className="flex-[1_1_140px]">
                    <select className={INPUT} value={r.method} aria-invalid={bad('method')} onChange={(e) => set(r.key, { method: e.target.value as Method })}>
                      <option value="" disabled>{t.pickMethod}</option>
                      {METHODS.map((k) => <option key={k} value={k}>{m.labels.method[k]}</option>)}
                    </select>
                  </Field>
                  <Field label={t.color} className="flex-[1_1_140px]"><input className={INPUT} value={r.garmentColor} onChange={(e) => set(r.key, { garmentColor: e.target.value })} /></Field>
                </>
              ) : (
                <Field label={t.description} className="flex-[2_1_320px]"><input className={INPUT} value={r.description} aria-invalid={bad('description')} onChange={(e) => set(r.key, { description: e.target.value })} /></Field>
              )}
            </div>
            {r.kind === 'product' && (
              <div className="flex flex-wrap gap-3">
                <Field label={t.details} className="flex-[1_1_280px]"><input className={INPUT} value={r.description} onChange={(e) => set(r.key, { description: e.target.value })} /></Field>
                <Field label={t.internalNote} className="flex-[1_1_220px]"><input className={INPUT} value={r.notes} onChange={(e) => set(r.key, { notes: e.target.value })} /></Field>
              </div>
            )}
            {r.kind === 'product' && (
              <div className="flex flex-col gap-1.5">
                <Check checked={r.useSizes} onChange={(v) => set(r.key, v ? { useSizes: true } : { useSizes: false, quantity: String(rowQuantity(r) || '') })}>{t.useSizes}</Check>
                {r.useSizes && (
                  <div className="flex flex-wrap gap-1" aria-invalid={bad('quantity')}>
                    {columns.map((size) => (
                      <label key={size} className="flex w-14 flex-col gap-1">
                        <span className={cn(LBL, 'text-center')} aria-hidden>{size}</span>
                        <input
                          className={cn(INPUT, 'num px-1 text-center')} type="number" inputMode="numeric" min={0} aria-label={t.sizeLabel(size, number)}
                          value={r.sizes[size] ?? ''} onChange={(e) => set(r.key, { sizes: { ...r.sizes, [size]: e.target.value } })}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <Field label={t.quantity} className="w-[84px]">
                <input
                  className={cn(INPUT, 'num text-right')} type="number" inputMode="numeric" min={1} readOnly={r.useSizes} aria-invalid={bad('quantity')}
                  value={r.useSizes ? (rowQuantity(r) || '') : r.quantity} onChange={(e) => set(r.key, { quantity: e.target.value })}
                />
              </Field>
              <Field label={t.unitPrice} className="w-[104px]">
                <input className={cn(INPUT, 'text-right')} inputMode="decimal" placeholder="0.00" aria-invalid={bad('price')} value={r.unitPrice} onChange={(e) => set(r.key, { unitPrice: e.target.value })} />
              </Field>
              <div className="flex w-[110px] flex-col gap-1">
                <span className={cn(LBL, 'text-right')}>{t.lineTotal}</span>
                <span className="num flex h-[34px] items-center justify-end font-semibold">{line === null ? m.common.dash : fmt.money(line)}</span>
              </div>
              <button type="button" className={cn(BTN, BTN_SM)} aria-label={t.remove(number)} onClick={() => onChange(rows.filter((x) => x.key !== r.key))}>{m.common.remove}</button>
            </div>
            {r.kind === 'product' && r.useSizes && <span className={LBL}>{t.sizesSum(rowQuantity(r))}</span>}
            {issues.length > 0 && <p role="alert" className="text-xs text-status-red-fg">{issues.map((i) => t.issue[i]).join(' ')}</p>}
          </div>
        )
      })}
      <div className="flex flex-wrap gap-2 border-t border-secondary px-4 py-3">
        {(['product', 'charge', 'discount'] as const).map((k) => (
          <button key={k} type="button" className={BTN} onClick={() => onChange([...rows, newRow(k)])}>
            <Plus className="size-[15px]" strokeWidth={2} aria-hidden />{t.add[k]}
          </button>
        ))}
      </div>
      <TotalsBlock totals={totals} pieces={pieces} />
    </div>
  )
}

export function TotalsBlock({ totals, pieces }: { totals: ReturnType<typeof totalsOf>; pieces: number }) {
  const { m, fmt } = useI18n()
  const t = m.items.totals
  const ok = totals && !('error' in totals) ? totals : null
  const row = (label: string, value: string) => <div className="flex justify-between gap-6"><span className="text-muted-foreground">{label}</span><span className="num">{value}</span></div>
  return (
    <div className="flex justify-end border-t border-border px-4 py-3.5">
      <div className="flex w-[300px] max-w-full flex-col gap-1.5 text-[13px]" aria-live="polite">
        {row(t.subtotal(pieces), ok ? fmt.money(ok.subtotalCents) : m.common.dash)}
        {row(t.charges, ok ? fmt.money(ok.chargesCents) : m.common.dash)}
        {row(t.discounts, ok ? `−${fmt.money(ok.discountsCents)}` : m.common.dash)}
        <div className="flex justify-between gap-6 border-t border-border pt-2 text-[15px] font-semibold"><span>{t.total}</span><span className="num">{ok ? fmt.money(ok.totalCents) : m.common.dash}</span></div>
        {totals && 'error' in totals && totals.error === 'discount_exceeds_total' && <p role="alert" className="text-xs text-status-red-fg">{m.api.errors.discount_exceeds_total}</p>}
      </div>
    </div>
  )
}

/** Why a set of rows can't be saved, or null. Shared by New order and the workspace editor. */
export function rowsInvalid(rows: Row[]): boolean {
  const t = totalsOf(rows)
  return rows.some((r) => rowIssues(r).length > 0) || (t !== null && 'error' in t)
}
