import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { business } from '@shared/business'
import { EMPTY_FORM, MAX_ITEMS, METHOD_NAMES, PRODUCTS, SIZES, buildPayload, clearDraft, describeItem, duplicateItem, itemTitle, loadDraft, methodsFor, patchItem, productOf, saveDraft, sizeTotal, toggleProduct, validateStep, type Errors, type Form, type Item } from './orderForm'
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
  const full = f.items.length >= MAX_ITEMS
  return (
    <>
      <StepHeading focus={focus}>What would you like made?</StepHeading>
      <fieldset data-invalid={errors.product ? true : undefined} aria-describedby={errors.product ? 's-product-error' : undefined}>
        <legend className="s-label s-legend-gap">Choose one or more</legend>
        <div className="s-tiles">
          {PRODUCTS.map((p) => (
            <label key={p.slug} className="s-tile-choice">
              <input type="checkbox" className="s-visually-hidden" disabled={full && !f.items.some((i) => i.product === p.slug)} checked={f.items.some((i) => i.product === p.slug)} onChange={() => set((x) => toggleProduct(x, p.slug))} />
              <span className="s-tile-name">{p.name}</span><small>{p.hint}</small>
              <Check aria-hidden size={18} strokeWidth={2.4} className="s-tile-check" />
            </label>
          ))}
        </div>
        {errors.product && <p id="s-product-error" className="s-error">{errors.product}</p>}
        {full && <p className="s-meta s-full-note">One request can hold {MAX_ITEMS} items. To add more, describe them in your project details.</p>}
      </fieldset>
      {f.items.map((item) => {
        const name = productOf(item)?.name
        const error = errors[`method-${item.key}`]
        return (
          <fieldset key={item.key} role="radiogroup" aria-invalid={error ? true : undefined} aria-describedby={error ? `method-${item.key}-error` : undefined}>
            <legend className="s-label">How should we decorate: {name}?</legend>
            <p className="s-meta s-legend-help">Showing the options that work for this item.</p>
            <div className="s-options">
              {methodsFor(item.product).map((m, i) => (
                <label key={m} className="s-option" style={{ animationDelay: `${i * 40}ms` }}>
                  <input type="radio" name={`method-${item.key}`} className="s-visually-hidden" checked={item.method === m} onChange={() => set((x) => patchItem(x, item.key, { method: m }))} />
                  <span>{METHOD_NAMES[m]}</span><Check aria-hidden size={20} strokeWidth={2.4} className="s-option-check" />
                </label>
              ))}
            </div>
            {error && <p id={`method-${item.key}-error`} className="s-error">{error}</p>}
          </fieldset>
        )
      })}
    </>
  )
}

const digits = (s: string) => s.replace(/\D/g, '').slice(0, 6)

/** The fields follow the product: a size grid for apparel, one quantity for anything else, and what engraving needs. */
function ItemCard({ item, f, set, error, canRemove }: { item: Item; f: Form; set: (fn: (f: Form) => Form) => void; error?: string; canRemove: boolean }) {
  const change = (c: Partial<Item>) => set((x) => patchItem(x, item.key, c))
  const sized = productOf(item)?.sized
  const extra = item.product === 'trophies'
    ? { key: 'personalization' as const, label: 'Names or wording to engrave (optional)', help: 'Or tell us the list will follow.' }
    : item.product === 'engraved' ? { key: 'material' as const, label: 'Material or item (optional)', help: undefined }
    : { key: 'color' as const, label: sized ? 'Garment color (optional)' : 'Color (optional)', help: undefined }
  const errorId = `quantity-${item.key}-error`
  return (
    <section className="s-item" aria-label={itemTitle(item)}>
      <h2 className="s-display s-item-title">{itemTitle(item)}</h2>
      {sized ? (
        <fieldset aria-describedby={error ? errorId : undefined}>
          <legend className="s-label s-legend-gap">Quantity per size</legend>
          <div className="s-sizes">
            {SIZES.map((s) => (
              <div key={s} className="s-size">
                <label htmlFor={`size-${item.key}-${s}`}>{s}</label>
                <input id={`size-${item.key}-${s}`} inputMode="numeric" pattern="[0-9]*" enterKeyHint="next" autoComplete="off" aria-invalid={error ? true : undefined} value={item.sizes[s] ?? ''} placeholder="0" onChange={(e) => change({ sizes: { ...item.sizes, [s]: digits(e.target.value) } })} />
              </div>
            ))}
          </div>
          <p className="s-meta s-size-total">Total: <strong>{sizeTotal(item)}</strong></p>
          {error && <p id={errorId} className="s-error">{error}</p>}
        </fieldset>
      ) : (
        <Field id={`quantity-${item.key}`} label="Quantity" error={error}>
          {(a) => <input {...a} className="s-input" inputMode="numeric" pattern="[0-9]*" enterKeyHint="next" autoComplete="off" value={item.quantity} onChange={(e) => change({ quantity: digits(e.target.value) })} />}
        </Field>
      )}
      <Field id={`extra-${item.key}`} label={extra.label} help={extra.help}>
        {(a) => extra.key === 'personalization'
          ? <textarea {...a} className="s-input s-textarea" maxLength={4000} value={item.personalization} onChange={(e) => change({ personalization: e.target.value })} />
          : <input {...a} className="s-input" maxLength={100} value={item[extra.key]} onChange={(e) => change({ [extra.key]: e.target.value })} />}
      </Field>
      <div className="s-item-actions">
        {f.items.length < MAX_ITEMS && <button type="button" className="s-link-button" onClick={() => set((x) => duplicateItem(x, item.key))}>Add another {productOf(item)?.name}, such as a second color</button>}
        {canRemove && <button type="button" className="s-link-button" aria-label={`Remove ${itemTitle(item)}`} onClick={() => {
          set((x) => ({ ...x, items: x.items.filter((i) => i.key !== item.key) }))
          document.querySelector<HTMLElement>('.s-step h1')?.focus({ preventScroll: true }) // the button is about to go; focus must not fall to the page
        }}>Remove</button>}
      </div>
    </section>
  )
}

function QuantityStep({ f, set, patch, errors, focus }: { f: Form; set: (fn: (f: Form) => Form) => void; patch: (c: Partial<Form>) => void; errors: Errors; focus: boolean }) {
  const today = useMemo(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10), [])
  return (
    <>
      <StepHeading focus={focus}>{f.items.length > 1 ? 'How many of each?' : productOf(f.items[0])?.sized ? 'How many, and which sizes?' : 'How many do you need?'}</StepHeading>
      {f.items.map((item) => <ItemCard key={item.key} item={item} f={f} set={set} error={errors[`quantity-${item.key}`]} canRemove={f.items.length > 1} />)}
      <section className="s-describe" aria-labelledby="s-describe-title">
        <h2 id="s-describe-title" className="s-display">Tell us about your project</h2>
        <label htmlFor="description" className="s-visually-hidden">Project description (optional)</label>
        <p id="description-help" className="s-meta">Optional, and it helps us quote accurately. It helps to mention:</p>
        <ul className="s-examples">
          <li><strong>Placement:</strong> left chest, full back, sleeve</li>
          <li><strong>Colors:</strong> ink or thread colors, school colors</li>
          <li><strong>Special instructions:</strong> names and numbers, a logo to match</li>
          <li><strong>Event:</strong> a tournament, banquet or fundraiser</li>
        </ul>
        <textarea id="description" aria-describedby="description-help" className="s-input s-textarea s-textarea-large" maxLength={4000} value={f.description} onChange={(e) => patch({ description: e.target.value })} />
      </section>
      <Field id="due" label="Requested deadline (optional)" help="This is a request, not a guaranteed date. We will confirm what is possible." error={errors.dueDate}>
        {(a) => <input {...a} className="s-input" type="date" min={today} value={f.dueDate} onChange={(e) => patch({ dueDate: e.target.value })} />}
      </Field>
    </>
  )
}

function ReviewRow({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <div className="s-review-row">
      <div className="s-review-head"><h3>{title}</h3><button type="button" className="s-link-button" aria-label={`Edit ${title.toLowerCase()}`} onClick={onEdit}>Edit</button></div>
      {children}
    </div>
  )
}

function DetailsStep({ f, patch, errors, focus, files, go }: { f: Form; patch: (c: Partial<Form>) => void; errors: Errors; focus: boolean; files: string[]; go: (n: number) => void }) {
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
            {(a) => <input {...a} className="s-input" autoComplete="organization" enterKeyHint="next" maxLength={200} value={f.organization} onChange={(e) => patch({ organization: e.target.value })} />}
          </Field>
        </>
      )}
      <Field id="name" label="Your name" error={errors.contactName}>
        {(a) => <input {...a} className="s-input" autoComplete="name" enterKeyHint="next" maxLength={200} value={f.contactName} onChange={(e) => patch({ contactName: e.target.value })} />}
      </Field>
      <Field id="email" label="Email" error={errors.contactEmail} help="An email or a phone number is enough.">
        {(a) => <input {...a} className="s-input" type="email" inputMode="email" autoCapitalize="off" autoComplete="email" enterKeyHint="next" maxLength={254} value={f.contactEmail} onChange={(e) => patch({ contactEmail: e.target.value })} />}
      </Field>
      <Field id="phone" label="Phone" error={errors.contactPhone}>
        {(a) => <input {...a} className="s-input" type="tel" inputMode="tel" autoComplete="tel" enterKeyHint="done" maxLength={30} value={f.contactPhone} onChange={(e) => patch({ contactPhone: e.target.value })} />}
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
      <section aria-labelledby="s-review-title" className="s-review">
        <h2 id="s-review-title" className="s-display">Review your request</h2>
        <p className="s-meta">Everything you have entered stays in place when you go back to change it.</p>
        <ReviewRow title="What you would like made" onEdit={() => go(1)}>
          <ul className="s-review-list">{f.items.map((i) => <li key={i.key}>{describeItem(i)}{i.color ? `, ${i.color}` : ''}{i.material ? `, ${i.material}` : ''}</li>)}</ul>
        </ReviewRow>
        <ReviewRow title="Your project" onEdit={() => go(2)}>
          {f.description ? <p className="s-pre">{f.description}</p> : <p>No description added.</p>}
          <p>{f.dueDate ? `Requested deadline: ${f.dueDate}. We will confirm what is possible.` : 'No deadline requested.'}</p>
        </ReviewRow>
        <ReviewRow title="Artwork" onEdit={() => go(3)}>
          {files.length > 0 ? <ul className="s-review-list">{files.map((n, i) => <li key={`${n}-${i}`}>{n}</li>)}</ul> : <p>No files attached. That is fine, artwork is optional.</p>}
          {f.designHelp && <p>You asked for help with the design.</p>}
        </ReviewRow>
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
    // A service link adds to what is already in progress; it never discards it.
    const method = params.get('method')
    const seeded = { ...EMPTY_FORM, ...draft?.form, preferMethod: method && method in METHOD_NAMES ? method : '' }
    const product = params.get('product')
    return PRODUCTS.some((p) => p.slug === product) && !seeded.items.some((i) => i.product === product) ? toggleProduct(seeded, product!) : seeded
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

  const currentToken = useCallback(() => token.current, [])
  const uploadsConfig = useMemo(() => ({ initial: draft?.files ?? [], ensureToken, currentToken, dropToken, onClosed }), [draft, ensureToken, currentToken, dropToken, onClosed])
  const uploads = useUploads(uploadsConfig)
  // After a reload, the server knows what got through: an upload whose reply never arrived, or a session that ended.
  const { reconcile } = uploads
  useEffect(() => { void reconcile().catch(() => {}) }, [reconcile])

  const requested = Number(params.get('step')) || 1
  // A later step is only reachable with the earlier ones complete, whatever the history or address says.
  const furthest = Object.keys(validateStep(1, form)).length > 0 ? 1 : Object.keys(validateStep(2, form)).length > 0 ? 2 : STEP_COUNT
  const step = Math.min(Math.max(requested, 1), furthest)
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
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.s-step fieldset[data-invalid] input, .s-step [role="radiogroup"][aria-invalid="true"] input, .s-step input[aria-invalid="true"], .s-step textarea[aria-invalid="true"], .s-step select[aria-invalid="true"]')?.focus())
    if (Object.keys(e).length > 0) setFormError('Please check the highlighted fields.')
  }

  const uploading = uploads.rows.some((r) => r.state === 'uploading' || r.state === 'removing')
  const failed = uploads.rows.some((r) => r.state === 'failed')

  useEffect(() => {
    if (!uploading && !failed) setFormError((m) => (/did not upload|still uploading|go up again|difference in your files/.test(m) ? '' : m)) // a message about a problem now fixed
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
      // What the session holds is what gets sent, so the customer must have seen it first.
      const had = uploads.current().filter((r) => r.state === 'done').length
      if (!(await uploads.reconcile()) && had > 0) {
        go(3)
        return setFormError('Your session ended, so your files need to go up again. Nothing else was lost.')
      }
      const rows = uploads.current()
      if (rows.some((r) => r.state === 'failed')) {
        go(3)
        return setFormError('Some files did not upload. Retry or remove them to continue.')
      }
      if (rows.filter((r) => r.state === 'done').length !== had) {
        go(3)
        return setFormError('We found a difference in your files. Please check them, then continue.')
      }
      const { ref } = await submitInquiry(await ensureToken(), parsed.data)
      clearDraft()
      const sent: SentState = {
        lines: form.items.map(describeItem), description: form.description.trim(), dueDate: form.dueDate,
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
      <p role="status" className="s-visually-hidden">Step {step} of {STEP_COUNT}: {TITLES[step - 1]}</p>
      <div className="s-order-body">
        <form noValidate onSubmit={(e) => { e.preventDefault(); if (step === STEP_COUNT) void send(); else next() }}>
          {step > 1 && <button type="button" className="s-back" onClick={() => go(step - 1)}>Back</button>}
          <StepPanel step={step} dir={dir}>
            {step === 1 && <ProductStep f={form} set={set} errors={errors} focus={moved} />}
            {step === 2 && <QuantityStep f={form} set={set} patch={patch} errors={errors} focus={moved} />}
            {step === 3 && (
              <>
                <StepHeading focus={moved}>Send us your artwork.</StepHeading>
                <UploadStep form={form} set={patch} uploads={uploads} />
              </>
            )}
            {step === 4 && <DetailsStep f={form} patch={patch} errors={errors} focus={moved} files={uploads.rows.map((r) => r.name)} go={go} />}
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
