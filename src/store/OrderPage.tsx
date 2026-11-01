import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { business } from '@shared/business'
import { EMPTY_FORM, METHOD_NAMES, PRODUCTS, SIZES, buildPayload, chooseProduct, clearDraft, loadDraft, methodsFor, productOf, saveDraft, sizeTotal, summarize, validateStep, type Errors, type Form } from './orderForm'
import { PublicError, SESSION_ENDED, fetchStatus, openSession, submitInquiry, type Status } from './publicApi'
import type { SentState } from './SentPage'
import { Contact, usePageTitle } from './StoreLayout'
import { UploadStep } from './UploadStep'
import { useUploads } from './useUploads'

const EASE_OUT = [0.23, 1, 0.32, 1] as const
const STEP_COUNT = 4
const TITLES = ['What', 'How many', 'Artwork', 'You']

function Field({ id, label, error, help, children }: { id: string; label: string; error?: string; help?: string; children: (a: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => ReactNode }) {
  const describedBy = [error && `${id}-error`, help && `${id}-help`].filter(Boolean).join(' ') || undefined
  return (
    <div className="s-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {help && <span id={`${id}-help`} className="s-meta">{help}</span>}
      {error && <span id={`${id}-error`} className="s-error">{error}</span>}
    </div>
  )
}

/** Takes focus when a step arrives, so a screen reader hears the new step and Tab starts from it. Not on first load. */
function StepHeading({ children, focus }: { children: ReactNode; focus: boolean }) {
  return <h1 tabIndex={-1} className="s-display s-h-order" ref={(el) => { if (focus) el?.focus({ preventScroll: true }) }}>{children}</h1>
}

function ProductStep({ f, set, errors, focus }: { f: Form; set: (fn: (f: Form) => Form) => void; errors: Errors; focus: boolean }) {
  const methods = f.product ? methodsFor(f.product) : []
  return (
    <>
      <StepHeading focus={focus}>What would you like made?</StepHeading>
      <fieldset aria-describedby={errors.product ? 's-product-error' : undefined}>
        <legend className="s-visually-hidden">Product</legend>
        <div className="s-tiles">
          {PRODUCTS.map((p) => (
            <label key={p.slug} className="s-tile-choice">
              <input type="radio" name="product" className="s-visually-hidden" checked={f.product === p.slug} onChange={() => set((x) => chooseProduct(x, p.slug))} />
              <span className="s-tile-name">{p.name}</span><small>{p.hint}</small>
            </label>
          ))}
        </div>
        {errors.product && <p id="s-product-error" className="s-error">{errors.product}</p>}
      </fieldset>
      {f.product && (
        <fieldset aria-describedby={errors.method ? 's-method-error' : undefined}>
          <legend className="s-label">How should we decorate it?</legend>
          <p className="s-meta s-legend-help">Showing the options that work for this item.</p>
          <div className="s-options" key={f.product}>
            {methods.map((m, i) => (
              <label key={m} className="s-option" style={{ animationDelay: `${i * 40}ms` }}>
                <input type="radio" name="method" className="s-visually-hidden" checked={f.method === m} onChange={() => set((x) => ({ ...x, method: m }))} />
                <span>{METHOD_NAMES[m]}</span><Check aria-hidden size={20} strokeWidth={2.4} className="s-option-check" />
              </label>
            ))}
          </div>
          {errors.method && <p id="s-method-error" className="s-error">{errors.method}</p>}
        </fieldset>
      )}
    </>
  )
}

const digits = (s: string) => s.replace(/\D/g, '').slice(0, 6)

function QuantityStep({ f, patch, errors, focus }: { f: Form; patch: (c: Partial<Form>) => void; errors: Errors; focus: boolean }) {
  const product = productOf(f)
  const extra = f.product === 'trophies'
    ? { key: 'personalization' as const, label: 'Names or wording to engrave (optional)', help: 'Or tell us the list will follow.' }
    : f.product === 'engraved' ? { key: 'material' as const, label: 'Material or item (optional)', help: undefined }
    : { key: 'color' as const, label: 'Color (optional)', help: undefined }
  const today = useMemo(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10), [])
  return (
    <>
      <StepHeading focus={focus}>{product?.sized ? 'How many, and which sizes?' : 'How many do you need?'}</StepHeading>
      <p className="s-meta s-tight-top">{summarize(f).split('.')[0]}</p>
      {product?.sized ? (
        <fieldset aria-describedby={errors.quantity ? 's-quantity-error' : 's-size-total'}>
          <legend className="s-label s-legend-gap">Quantity per size</legend>
          <div className="s-sizes">
            {SIZES.map((s) => (
              <div key={s} className="s-size">
                <label htmlFor={`size-${s}`}>{s}</label>
                <input id={`size-${s}`} inputMode="numeric" autoComplete="off" aria-invalid={errors.quantity ? true : undefined} value={f.sizes[s] ?? ''} placeholder="0" onChange={(e) => patch({ sizes: { ...f.sizes, [s]: digits(e.target.value) } })} />
              </div>
            ))}
          </div>
          <p id="s-size-total" className="s-meta s-size-total">Total: <strong>{sizeTotal(f)}</strong></p>
          {errors.quantity && <p id="s-quantity-error" className="s-error">{errors.quantity}</p>}
        </fieldset>
      ) : (
        <Field id="quantity" label="Quantity" error={errors.quantity}>
          {(a) => <input {...a} className="s-input" inputMode="numeric" autoComplete="off" value={f.quantity} onChange={(e) => patch({ quantity: digits(e.target.value) })} />}
        </Field>
      )}
      <Field id="extra" label={extra.label} help={extra.help}>
        {(a) => extra.key === 'personalization'
          ? <textarea {...a} className="s-input s-textarea" maxLength={4000} value={f.personalization} onChange={(e) => patch({ personalization: e.target.value })} />
          : <input {...a} className="s-input" maxLength={100} value={f[extra.key]} onChange={(e) => patch({ [extra.key]: e.target.value })} />}
      </Field>
      <Field id="due" label="Needed by (optional)" help="We will confirm what is possible." error={errors.dueDate}>
        {(a) => <input {...a} className="s-input" type="date" min={today} value={f.dueDate} onChange={(e) => patch({ dueDate: e.target.value })} />}
      </Field>
      <Field id="notes" label="Anything else we should know? (optional)">
        {(a) => <textarea {...a} className="s-input s-textarea" maxLength={2000} value={f.notes} onChange={(e) => patch({ notes: e.target.value })} />}
      </Field>
    </>
  )
}

function DetailsStep({ f, patch, errors, focus, fileCount }: { f: Form; patch: (c: Partial<Form>) => void; errors: Errors; focus: boolean; fileCount: number }) {
  return (
    <>
      <StepHeading focus={focus}>How can we reach you?</StepHeading>
      {f.forOrganization && (
        <>
          <fieldset>
            <legend className="s-label s-legend-gap">Who is this for?</legend>
            <div className="s-options">
              {([['district', 'A school or district'], ['organization', 'Another organization']] as const).map(([value, label]) => (
                <label key={value} className="s-option s-option-still">
                  <input type="radio" name="kind" className="s-visually-hidden" checked={f.customerKind === value} onChange={() => patch({ customerKind: value })} />
                  <span>{label}</span><Check aria-hidden size={20} strokeWidth={2.4} className="s-option-check" />
                </label>
              ))}
            </div>
          </fieldset>
          <Field id="organization" label="School, district or organization" error={errors.organization}>
            {(a) => <input {...a} className="s-input" autoComplete="organization" maxLength={200} value={f.organization} onChange={(e) => patch({ organization: e.target.value })} />}
          </Field>
        </>
      )}
      <Field id="name" label="Your name" error={errors.contactName}>
        {(a) => <input {...a} className="s-input" autoComplete="name" maxLength={200} value={f.contactName} onChange={(e) => patch({ contactName: e.target.value })} />}
      </Field>
      <Field id="email" label="Email" error={errors.contactEmail} help="An email or a phone number is enough.">
        {(a) => <input {...a} className="s-input" type="email" autoComplete="email" maxLength={254} value={f.contactEmail} onChange={(e) => patch({ contactEmail: e.target.value })} />}
      </Field>
      <Field id="phone" label="Phone" error={errors.contactPhone}>
        {(a) => <input {...a} className="s-input" type="tel" autoComplete="tel" maxLength={30} value={f.contactPhone} onChange={(e) => patch({ contactPhone: e.target.value })} />}
      </Field>
      <Field id="preferred" label="Best way to reach you (optional)">
        {(a) => (
          <select {...a} className="s-input" value={f.preferredContact} onChange={(e) => patch({ preferredContact: e.target.value as Form['preferredContact'] })}>
            <option value="">Either is fine</option><option value="email">Email</option><option value="phone">Phone</option>
          </select>
        )}
      </Field>
      {/* Hidden from people; a bot that fills it in looks accepted but lands as spam. */}
      <div className="s-hp" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => patch({ website: e.target.value })} />
      </div>
      <section aria-label="Review your request" className="s-review">
        <h2 className="s-display">Your request</h2>
        <p>{summarize(f)} {fileCount === 0 ? 'No files attached.' : `${fileCount} ${fileCount === 1 ? 'file' : 'files'} attached.`}{f.designHelp ? ' You asked for design help.' : ''}</p>
      </section>
      <p className="s-meta">By sending this, you agree that we use these details to reply and quote. See our <Link to="/privacy" target="_blank" rel="noopener">privacy page (opens in a new tab)</Link>.</p>
    </>
  )
}

function ClosedNotice() {
  return (
    <div className="s-closed">
      <h1 tabIndex={-1} className="s-display s-h-order">We are not taking online requests right now.</h1>
      <p className="s-body">Please call or email us and we will be glad to help.</p>
      <p className="s-body">Call <Contact field="phone" label="phone number" /> or email <Contact field="email" label="email address" />.</p>
      <Link to="/" viewTransition className="s-btn-ghost">Back to home</Link>
    </div>
  )
}

/** Direction-aware enter and exit. Adapted from Motion Primitives' Transition Panel (MIT): exit is faster than enter, reduced motion only fades. */
function StepPanel({ step, dir, children }: { step: number; dir: number; children: ReactNode }) {
  const reduce = useReducedMotion()
  const from = (d: number) => (reduce ? { opacity: 0 } : { opacity: 0, transform: `translateX(${d * 24}px)` })
  return (
    <AnimatePresence mode="wait" initial={false} custom={dir}>
      <motion.div
        key={step}
        className="s-step"
        custom={dir}
        variants={{ enter: (d: number) => from(d), rest: { opacity: 1, transform: 'translateX(0px)' }, leave: (d: number) => from(-d) }}
        initial="enter"
        animate="rest"
        exit="leave"
        transition={{ duration: reduce ? 0.15 : 0.22, ease: EASE_OUT }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}

function OrderForm({ status, onClosed }: { status: Status; onClosed: () => void }) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const draft = useRef(loadDraft()).current
  const [form, setForm] = useState<Form>(() => {
    if (draft?.form.product) return draft.form
    const start = { ...EMPTY_FORM, ...draft?.form }
    const product = PRODUCTS.find((p) => p.slug === params.get('product'))
    const chosen = product ? chooseProduct(start, product.slug) : start
    const method = params.get('method')
    return method && method in METHOD_NAMES ? { ...chosen, method } : chosen
  })
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState('')
  const [sending, setSending] = useState(false)
  const token = useRef<string | null>(draft?.token ?? null)
  const opening = useRef<Promise<string> | null>(null)

  const dropToken = useCallback(() => { token.current = null }, [])
  /** Opened once, on the first file or at submit: parallel uploads share it. */
  const ensureToken = useCallback(async () => {
    if (token.current) return token.current
    opening.current ??= openSession(status.turnstileSiteKey).then((t) => { token.current = t; return t }).finally(() => { opening.current = null })
    return opening.current
  }, [status.turnstileSiteKey])

  const uploadsConfig = useMemo(() => ({ initial: draft?.files ?? [], ensureToken, dropToken, onClosed }), [draft, ensureToken, dropToken, onClosed])
  const uploads = useUploads(uploadsConfig)

  const requested = Number(params.get('step')) || 1
  const step = !form.product || !form.method ? 1 : Math.min(Math.max(requested, 1), STEP_COUNT)
  const lastStep = useRef(step)
  const dir = step >= lastStep.current ? 1 : -1
  const moved = lastStep.current !== step
  useEffect(() => {
    lastStep.current = step
    window.scrollTo(0, 0)
  }, [step])

  useEffect(() => {
    saveDraft({ form, token: token.current, files: uploads.rows.filter((r) => r.state === 'done' && r.id).map((r) => ({ id: r.id!, name: r.name, bytes: r.bytes, purpose: r.purpose })) })
  }, [form, uploads.rows])

  const set = useCallback((fn: (f: Form) => Form) => setForm(fn), [])
  const patch = useCallback((c: Partial<Form>) => setForm((f) => ({ ...f, ...c })), [])
  const go = (n: number) => { setFormError(''); setErrors({}); setParams(n === 1 ? {} : { step: String(n) }, { viewTransition: false }) }

  const failErrors = (e: Errors) => {
    setErrors(e)
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.s-step [aria-invalid="true"], .s-step .s-error')?.focus())
    if (Object.keys(e).length > 0) setFormError('Please check the highlighted fields.')
  }

  const uploading = uploads.rows.some((r) => r.state === 'uploading' || r.state === 'removing')
  const failed = uploads.rows.some((r) => r.state === 'failed')

  useEffect(() => {
    if (!uploading && !failed) setFormError((m) => (/did not upload|still uploading|go up again/.test(m) ? '' : m)) // a message about a problem now fixed
  }, [uploading, failed])

  const next = () => {
    const e = validateStep(step, form)
    if (Object.keys(e).length > 0) return failErrors(e)
    if (step === 3 && uploading) return setFormError('Your files are still uploading. This will be ready in a moment.')
    if (step === 3 && failed) return setFormError('Some files did not upload. Retry or remove them to continue.')
    go(step + 1)
  }

  const send = async (retried = false): Promise<void> => {
    const e = validateStep(4, form)
    if (Object.keys(e).length > 0) return failErrors(e)
    if (uploading) return setFormError('Your files are still uploading. Please wait a moment.')
    if (failed) { go(3); return setFormError('Some files did not upload. Retry or remove them to continue.') }
    const parsed = buildPayload(form)
    if (!parsed.success) return setFormError('Something in the form needs another look. Please go back and check each step.')
    setSending(true)
    setFormError('')
    try {
      const { ref } = await submitInquiry(await ensureToken(), parsed.data)
      clearDraft()
      const sent: SentState = {
        summary: summarize(form),
        poAttached: uploads.rows.some((r) => r.purpose === 'po'),
        previews: uploads.rows.map((r) => ({ name: r.name, url: r.preview ?? null })),
      }
      void navigate(`/order/sent/${ref}`, { replace: true, state: sent, viewTransition: true })
    } catch (err) {
      const pe = err as PublicError
      if (pe.code === 'intake_closed') return onClosed()
      if (SESSION_ENDED.has(pe.code)) {
        uploads.sessionEnded()
        if (uploads.rows.length === 0 && !retried) return await send(true) // nothing lost: a new session is invisible
        go(3)
        return setFormError('Your session ended, so your files need to go up again. Nothing else was lost.')
      }
      // A network failure may have delivered it. Same session, same answer, so "Send" again cannot make a second request.
      setFormError(`${pe.message} Your details are still here.`)
    } finally {
      setSending(false)
    }
  }

  usePageTitle(`Start an order: ${TITLES[step - 1]}`)
  return (
    <main className="s-order">
      <header className="s-order-header">
        <div className="s-order-header-row">
          <Link to="/" viewTransition className="s-logo">{business.shortName}</Link>
          <span className="s-meta s-step-label">Step {step} of {STEP_COUNT}</span>
        </div>
        <div role="progressbar" aria-label="Order progress" aria-valuemin={1} aria-valuemax={STEP_COUNT} aria-valuenow={step} aria-valuetext={`Step ${step} of ${STEP_COUNT}: ${TITLES[step - 1]}`} className="s-progress">
          <div style={{ transform: `scaleX(${step / STEP_COUNT})` }} />
        </div>
      </header>
      <div className="s-order-body">
        <form noValidate onSubmit={(e) => { e.preventDefault(); if (step === STEP_COUNT) void send(); else next() }}>
          {step > 1 && <button type="button" className="s-back" onClick={() => go(step - 1)}>Back</button>}
          <StepPanel step={step} dir={dir}>
            {step === 1 && <ProductStep f={form} set={set} errors={errors} focus={moved} />}
            {step === 2 && <QuantityStep f={form} patch={patch} errors={errors} focus={moved} />}
            {step === 3 && (
              <>
                <StepHeading focus={moved}>Send us your artwork.</StepHeading>
                <UploadStep form={form} set={patch} uploads={uploads} />
              </>
            )}
            {step === 4 && <DetailsStep f={form} patch={patch} errors={errors} focus={moved} fileCount={uploads.rows.length} />}
          </StepPanel>
          <div id="turnstile-slot" className="s-turnstile" />
          {formError && <p role="alert" className="s-error-block">{formError}</p>}
          <button type="submit" className="s-btn s-btn-block" disabled={sending} aria-busy={sending}>
            {step === STEP_COUNT ? (sending ? 'Sending your request' : 'Send my request') : step === 3 ? 'Continue to your details' : step === 2 ? 'Continue to artwork' : 'Continue'}
          </button>
        </form>
      </div>
    </main>
  )
}

export default function OrderPage() {
  const [status, setStatus] = useState<Status | 'loading' | 'failed'>('loading')
  const [closed, setClosed] = useState(false)
  const load = useCallback(() => {
    setStatus('loading')
    fetchStatus().then(setStatus, () => setStatus('failed'))
  }, [])
  useEffect(load, [load])
  const onClosed = useCallback(() => setClosed(true), [])
  usePageTitle('Start an order')

  if (status === 'loading') {
    return (
      <main className="s-order" aria-busy="true">
        <div className="s-order-body s-skeleton" role="status" aria-label="Loading the form"><div /><div /><div /></div>
      </main>
    )
  }
  if (status === 'failed') {
    return (
      <main className="s-order">
        <div className="s-closed">
          <h1 tabIndex={-1} className="s-display s-h-order">We could not load the form.</h1>
          <p className="s-body">Check your connection and try again.</p>
          <button type="button" className="s-btn" onClick={load}>Try again</button>
        </div>
      </main>
    )
  }
  if (!status.open || closed) return <main className="s-order"><ClosedNotice /></main>
  return <OrderForm status={status} onClosed={onClosed} />
}
