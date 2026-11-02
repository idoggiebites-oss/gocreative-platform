import { useState } from 'react'
import { Link, Navigate, useLocation, useParams } from 'react-router'
import { Check, Copy, FileText } from 'lucide-react'
import { business } from '@shared/business'
import type { CustomerEstimate } from '@shared/inquiry'
import { EstimateNotice } from './EstimateNotice'
import { Contact, usePageTitle } from './StoreLayout'

export type SentState = { lines: string[]; description: string; dueDate: string; poAttached: boolean; previews: { name: string; url: string | null }[]; estimate?: CustomerEstimate; estimateChanged?: boolean }

function CopyRef({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard refused: the reference is on screen to read */ }
  }
  return (
    <button type="button" className="s-copy" onClick={copy}>
      {copied ? <Check aria-hidden size={16} /> : <Copy aria-hidden size={16} />}
      <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}

export default function SentPage() {
  usePageTitle('Request received')
  const { ref } = useParams()
  const state = useLocation().state as SentState | null
  if (!ref || !/^INQ-[2-9A-HJ-NP-Z]{6}$/.test(ref)) return <Navigate to="/order" replace /> // only ever shows a well-formed reference

  return (
    <main className="s-sent">
      <header className="s-order-header"><div className="s-order-header-row"><Link to="/" viewTransition className="s-logo">{business.shortName}</Link></div></header>
      <div className="s-sent-body">
        <div className="s-mark" aria-hidden><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg></div>
        <h1 tabIndex={-1} ref={(el) => el?.focus({ preventScroll: true })} className="s-display s-h-sent s-rise-1">Thanks. We have your request.</h1>
        <div className="s-ref s-rise-2">
          <span>Your reference</span>
          <div className="s-ref-row"><strong className="s-display">{ref}</strong><CopyRef value={ref} /></div>
          <span>Mention it if you call or email us.</span>
        </div>
        {state?.estimate && <EstimateNotice estimate={state.estimate} changed={state.estimateChanged} />}
        <h2 className="s-display s-h-next s-rise-3">What happens next</h2>
        <ol className="s-next s-rise-3">
          <li><strong>We review your request</strong><p>We will contact you by email or phone.</p></li>
          <li><strong>You get a final quote</strong><p>If your order uses artwork, we show you a proof too. Nothing is made until you approve.</p></li>
          <li><strong>We make it, you pick it up</strong><p>We let you know when it is ready.</p></li>
        </ol>
        {state && (
          <section className="s-sent-summary" aria-labelledby="s-what-you-sent">
            <h2 id="s-what-you-sent" className="s-display">What you sent</h2>
            {state.previews.length > 0 && (
              <ul className="s-sent-files">
                {state.previews.map((p) => (
                  <li key={p.name}><div className="s-sent-thumb">{p.url ? <img src={p.url} alt="" onError={(e) => { e.currentTarget.hidden = true }} /> : <FileText aria-hidden size={28} />}</div><span>{p.name}</span></li>
                ))}
              </ul>
            )}
            <ul className="s-sent-lines">{state.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            {state.description && <p className="s-pre">{state.description}</p>}
            {state.dueDate && <p>Requested deadline: {state.dueDate}. We will confirm what is possible.</p>}
            {state.poAttached && <p>PO attached, to be confirmed with you.</p>}
          </section>
        )}
        <p className="s-meta">Questions? Call <Contact field="phone" label="phone number" /> or email <Contact field="email" label="email address" />.</p>
        <Link to="/" viewTransition className="s-btn-ghost s-btn-block">Back to home</Link>
      </div>
    </main>
  )
}
