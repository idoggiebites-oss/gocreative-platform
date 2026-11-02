// A preliminary estimate on an inquiry, and the staff review of it. Nothing here is a quote: review writes a new estimate and never touches an order, an item or a price on one.
import { useEffect, useRef, useState } from 'react'
import type { EstimateDecoration, EstimateReviewRequest, EstimateSeedLine, EstimateView, InquiryEstimatesResponse } from '@shared/api'
import { defensibleColors, type ArtworkReport } from '@shared/inquiry'
import { useI18n } from '@/i18n'
import { send, useInquiryEstimates, useSend } from '@/lib/api'
import { analyzeFile, reportOf } from '@/lib/artworkAnalyzer'
import { BTN, BTN_PRIMARY, Check, Field, FormDialog, H2, INPUT, LINK, SEC, TEXTAREA } from './form'
import { CARD, Chip, MUTED, type Tone } from './ui'

const METHODS = ['screen', 'embroidery', 'dtg', 'laser_engrave', 'laser_cut', 'other', 'help']
const BANDS = ['small', 'medium', 'large'] as const
const FACT_TONE: Record<EstimateView['factsSource'], Tone> = { none: 'gray', customer_reported: 'amber', staff_reviewed: 'green' }
type Analysis = { fileId: number; report: ArtworkReport | null; refused: string | null }
const blank = (fileId: number | null): EstimateDecoration => ({ location: null, size: null, colors: null, complexity: null, machineMinutes: null, fileId })
const num = (v: string, max: number) => { const n = Number(v); return v.trim() !== '' && Number.isFinite(n) && n > 0 && n <= max ? n : null }

/** Reads the stored original through the signed-in file route: the customer's own report plays no part. */
async function analyzeStored(f: InquiryEstimatesResponse['artworkFiles'][number]): Promise<Analysis> {
  try {
    const res = await fetch(`/api/app/files/${f.id}`)
    if (!res.ok) return { fileId: f.id, report: null, refused: 'unreadable' }
    const outcome = await analyzeFile(new File([await res.blob()], f.filename ?? 'artwork', { type: f.mime }))
    const report = reportOf(outcome)
    return { fileId: f.id, report, refused: report ? null : 'refused' in outcome ? outcome.refused : 'unreadable' }
  } catch {
    return { fileId: f.id, report: null, refused: 'unreadable' }
  }
}

function ReviewDialog({ inquiryId, data, onClose }: { inquiryId: number; data: InquiryEstimatesResponse; onClose: () => void }) {
  const { m } = useI18n()
  const t = m.estimates
  const [lines, setLines] = useState<EstimateSeedLine[]>(data.seed)
  const [analyses, setAnalyses] = useState<Analysis[] | null>(data.artworkFiles.length === 0 ? [] : null)
  const [verified, setVerified] = useState(false)
  const [reason, setReason] = useState('')
  const review = useSend<unknown, EstimateReviewRequest>((b) => send('POST', `/inquiries/${inquiryId}/estimates/review`, b))
  const started = useRef(false)
  useEffect(() => {
    if (started.current || data.artworkFiles.length === 0) return
    started.current = true
    void data.artworkFiles.reduce(async (prev, f) => [...(await prev), await analyzeStored(f)], Promise.resolve<Analysis[]>([])).then((all) => {
      setAnalyses(all)
      // Start from what the stored file shows, not what a browser reported. Keeping this is not an override; changing it is.
      setLines((ls) => ls.map((l) => (l.method !== 'screen' ? l : { ...l, decorations: l.decorations.map((d) => (d.fileId === null ? d : { ...d, colors: defensibleColors(all.find((a) => a.fileId === d.fileId)?.report) })) })))
    })
  }, [data.artworkFiles])
  const patchLine = (i: number, c: Partial<EstimateSeedLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...c } : l)))
  const patchDec = (i: number, k: number, c: Partial<EstimateDecoration>) => patchLine(i, { decorations: lines[i].decorations.map((d, j) => (j === k ? { ...d, ...c } : d)) })
  const latest = data.estimates.at(-1)
  const method = (x: string) => (x === 'help' ? m.inquiries.helpMethod : (Object.hasOwn(m.labels.method, x) ? (m.labels.method as Record<string, string>)[x] : x))
  const fileName = (id: number) => data.artworkFiles.find((f) => f.id === id)?.filename ?? `#${id}`
  return (
    <FormDialog
      open onOpenChange={(o) => { if (!o) onClose() }} title={t.reviewTitle} description={t.reviewBody} submitLabel={t.reviewSubmit} pending={review.isPending} error={review.error}
      disabled={analyses === null || !verified}
      onSubmit={() => review.mutate(
        { basedOn: latest?.id ?? null, verified: true, reason: reason.trim() || null, reanalysis: analyses ?? [], lines: lines.map((l) => ({ method: l.method, decorations: l.decorations })) },
        { onSuccess: onClose },
      )}
    >
      <div className="flex flex-col gap-2 text-[13px]" data-testid="reanalysis">
        <h3 className="font-semibold">{t.storedFiles}</h3>
        {data.artworkFiles.length === 0 && <p className={MUTED}>{t.noArtwork}</p>}
        {data.artworkFiles.map((f) => {
          const a = analyses?.find((x) => x.fileId === f.id)
          const colors = defensibleColors(a?.report)
          return (
            <div key={f.id}>
              <a className={LINK} href={`/api/app/files/${f.id}`} target="_blank" rel="noopener">{f.filename ?? `#${f.id}`}</a>
              <p>{!analyses ? t.analyzing : colors !== null ? t.detected(colors) : t.noCount}</p>
              {a && (a.refused || (a.report?.flags.length ?? 0) > 0) && <p className={MUTED}>{(a.refused ? [a.refused] : a.report!.flags).map((x) => m.pricing.flags[x] ?? x).join(', ')}</p>}
            </div>
          )
        })}
        <p className={MUTED}>{t.notSeparation}</p>
      </div>
      {lines.map((l, i) => (
        <fieldset key={i} className="flex flex-col gap-2 border-t border-line pt-2" aria-label={`${l.product}, ${l.quantity}`}>
          <legend className="text-[13px] font-semibold">{l.product}, {l.quantity}</legend>
          <Field label={t.method}>
            <select className={INPUT} value={l.method} onChange={(e) => patchLine(i, { method: e.target.value })}>{METHODS.map((x) => <option key={x} value={x}>{method(x)}</option>)}</select>
          </Field>
          {l.decorations.map((d, k) => (
            <div key={k} className="flex flex-col gap-2 rounded border border-line p-2" data-testid={`decoration-${i}-${k}`}>
              <Field label={t.location}><input className={INPUT} maxLength={60} value={d.location ?? ''} onChange={(e) => patchDec(i, k, { location: e.target.value.trim() ? e.target.value : null })} /></Field>
              {data.artworkFiles.length > 0 && (
                <Field label={t.artwork}>
                  <select className={INPUT} value={d.fileId ?? ''} onChange={(e) => {
                    const fileId = e.target.value ? Number(e.target.value) : null
                    patchDec(i, k, { fileId, colors: fileId === null ? d.colors : defensibleColors(analyses?.find((a) => a.fileId === fileId)?.report) })
                  }}>
                    <option value="">{t.noFile}</option>
                    {data.artworkFiles.map((f) => <option key={f.id} value={f.id}>{fileName(f.id)}</option>)}
                  </select>
                </Field>
              )}
              {(l.method === 'screen' || l.method === 'dtg') && (
                <Field label={t.size}>
                  <select className={INPUT} value={d.size ?? ''} onChange={(e) => patchDec(i, k, { size: (e.target.value || null) as EstimateDecoration['size'] })}>
                    <option value="">{m.common.dash}</option>{BANDS.map((b) => <option key={b} value={b}>{t.bands[b]}</option>)}
                  </select>
                </Field>
              )}
              {l.method === 'screen' && <Field label={t.colors}><input className={INPUT} inputMode="numeric" value={d.colors ?? ''} onChange={(e) => patchDec(i, k, { colors: num(e.target.value.replace(/\D/g, ''), 100) })} /></Field>}
              {l.method === 'embroidery' && (
                <Field label={t.complexity}>
                  <select className={INPUT} value={d.complexity ?? ''} onChange={(e) => patchDec(i, k, { complexity: (e.target.value || null) as EstimateDecoration['complexity'] })}>
                    <option value="">{m.common.dash}</option>{BANDS.map((b) => <option key={b} value={b}>{t.bands[b]}</option>)}
                  </select>
                </Field>
              )}
              {(l.method === 'laser_engrave' || l.method === 'laser_cut') && <Field label={t.minutes}><input className={INPUT} inputMode="decimal" value={d.machineMinutes ?? ''} onChange={(e) => patchDec(i, k, { machineMinutes: num(e.target.value, 1440) })} /></Field>}
              <button type="button" className={`${BTN} self-start`} onClick={() => patchLine(i, { decorations: l.decorations.filter((_, j) => j !== k) })}>{t.removePrint}</button>
            </div>
          ))}
          {l.decorations.length < 10 && <button type="button" className={`${BTN} self-start`} onClick={() => patchLine(i, { decorations: [...l.decorations, blank(null)] })}>{t.addPrint}</button>}
        </fieldset>
      ))}
      <Field label={t.reason} hint={t.reasonHint}><textarea className={TEXTAREA} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <Check checked={verified} onChange={setVerified}>{t.verified}</Check>
    </FormDialog>
  )
}

function EstimateRow({ e }: { e: EstimateView }) {
  const { m, fmt } = useI18n()
  const t = m.estimates
  return (
    <div className="flex flex-col gap-1 text-[13px]" data-testid={`estimate-${e.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <strong>{e.totalCents === null ? t.manual : t.figure(fmt.money(e.totalCents))}</strong>
        <Chip tone={FACT_TONE[e.factsSource]}>{t.facts[e.factsSource]}</Chip>
      </div>
      <p className={MUTED}>{e.createdBy ? t.reviewedBy(e.createdBy, fmt.date(e.createdAt)) : t.fromCustomer(fmt.date(e.createdAt))}{e.pricingVersionId === null ? ` ${t.noPricing}` : ` ${t.pricingVersion(e.pricingVersionId)}`}</p>
      {e.shownToCustomer && <p>{t.shown}: {e.shownToCustomer.totalCents === null ? t.manual : fmt.money(e.shownToCustomer.totalCents)}</p>}
      {e.lines.length > 0 && <ul className={MUTED}>{e.lines.map((l, i) => <li key={i}>{l.label}: {l.quantity} × {fmt.money(l.unitPriceCents)} = {fmt.money(l.lineTotalCents)}</li>)}</ul>}
      {e.reasons.length > 0 && <ul>{e.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {e.assumptions.length > 0 && <ul className={MUTED}>{e.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>}
      {e.reanalysis.map((a) => <p key={a.fileId} className={MUTED}>{t.reanalyzed(a.filename ?? `#${a.fileId}`)}: {a.refused ? m.pricing.flags[a.refused] ?? a.refused : a.estimatedInkColors ?? t.noCount}{a.flags.length > 0 ? ` (${a.flags.map((x) => m.pricing.flags[x] ?? x).join(', ')})` : ''}</p>)}
      {e.overrides.length > 0 && (
        <ul data-testid="overrides">
          {e.overrides.map((o, i) => <li key={i}>{t.override(o.field, o.original ?? m.common.dash, o.replacement ?? m.common.dash)} {o.reason} ({o.by ?? m.common.dash}, {fmt.date(o.at)})</li>)}
        </ul>
      )}
      {e.internal && e.totalCents !== null && <p data-testid="estimate-internal" className={MUTED}>{t.internal(fmt.money(e.internal.costCents), e.internal.marginBps === null ? m.common.dash : `${(e.internal.marginBps / 100).toFixed(2)}%`)}</p>}
    </div>
  )
}

export default function InquiryEstimates({ inquiryId, canReview }: { inquiryId: number; canReview: boolean }) {
  const { m } = useI18n()
  const t = m.estimates
  const query = useInquiryEstimates(inquiryId)
  const [reviewing, setReviewing] = useState(false)
  const data = query.data
  if (!data) return null
  const ordered = [...data.estimates].reverse()
  return (
    <section className={CARD} aria-labelledby="inq-estimate">
      <div className={SEC}><h2 id="inq-estimate" className={H2}>{t.title}</h2></div>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className={MUTED}>{t.notQuote}</p>
        {ordered.length === 0 ? <p className="text-[13px]">{t.none}</p> : ordered.map((e) => <EstimateRow key={e.id} e={e} />)}
        {canReview && data.seed.length > 0 && <button type="button" className={`${BTN} ${BTN_PRIMARY} self-start`} onClick={() => setReviewing(true)}>{t.review}</button>}
      </div>
      {reviewing && <ReviewDialog inquiryId={inquiryId} data={data} onClose={() => setReviewing(false)} />}
    </section>
  )
}

