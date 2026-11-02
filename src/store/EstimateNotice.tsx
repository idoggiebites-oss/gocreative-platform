// A preliminary estimate as a customer sees it: one figure in the agreed words, or no figure. Never a final price or an acceptance.
import type { CustomerEstimate } from '@shared/inquiry'

const money = (cents: number) => `$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`

export function EstimateNotice({ estimate, changed = false, needs = [] }: { estimate: CustomerEstimate | null; changed?: boolean; needs?: string[] }) {
  return (
    <section className="s-estimate" aria-live="polite" aria-busy={estimate === null}>
      {estimate === null ? <p>Checking your estimate.</p> : estimate.totalCents === null ? (
        <>
          <p className="s-estimate-figure">Manual review required</p>
          <p>Our team will review your request and send you a final quote for approval. You can send it as it is.</p>
          {needs.length > 0 && <><p>For a preliminary estimate we would need:</p><ul className="s-review-list">{needs.map((n) => <li key={n}>{n}</li>)}</ul></>}
        </>
      ) : (
        <>
          <p className="s-estimate-figure">Preliminary estimate: {money(estimate.totalCents)}</p>
          {changed && <p>This figure was updated when you sent your request.</p>}
          <p>This estimate is based on your selections and uploaded artwork. Our team will review your request and send you a final quote for approval. Pricing may change after review.</p>
          {estimate.assumptions.length > 0 && <ul className="s-review-list">{estimate.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>}
        </>
      )}
    </section>
  )
}
