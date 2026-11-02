// The order form's data and rules. The server's schema (shared/inquiry.ts) stays the authority: this builds what it
// expects and gives friendly per-field messages first.
import { business } from '@shared/business'
import { PRINT_METHODS, estimatePreviewSchema, inquirySubmitSchema, type ArtworkReport } from '@shared/inquiry'

export type Product = { slug: string; name: string; hint: string; methods: readonly string[]; sized: boolean }
export const PRODUCTS: readonly Product[] = business.storefront.products
export const SIZES: readonly string[] = business.sizes
export const METHOD_NAMES: Record<string, string> = {
  screen: 'Screen printing', embroidery: 'Embroidery', dtg: 'Direct to garment', laser_engrave: 'Laser engraving', laser_cut: 'Laser cutting', other: 'Other', help: 'Help me choose',
}

export type Print = { key: string; location: string; size: string; artwork: string }
export const newPrint = (artwork?: string): Print => ({ key: crypto.randomUUID(), location: '', size: '', artwork: artwork ?? '' })
export type Item = {
  key: string; product: string; method: string; quantity: string; sizes: Record<string, string>
  color: string; material: string; personalization: string
  prints?: Print[] // absent on a draft saved before this field existed
}
export type Form = {
  items: Item[]; preferMethod: string; description: string; dueDate: string
  designHelp: boolean; forOrganization: boolean; customerKind: 'district' | 'organization'
  organization: string; contactName: string; contactEmail: string; contactPhone: string; preferredContact: '' | 'email' | 'phone'
  website: string
}
export const MAX_ITEMS = 10 // the most lines the server takes on one request
export const EMPTY_FORM: Form = {
  items: [], preferMethod: '', description: '', dueDate: '',
  designHelp: false, forOrganization: false, customerKind: 'district', organization: '', contactName: '', contactEmail: '', contactPhone: '', preferredContact: '', website: '',
}
export type Errors = Partial<Record<string, string>>

export const productOf = (i: Item) => PRODUCTS.find((p) => p.slug === i.product)
export const methodsFor = (slug: string) => [...(PRODUCTS.find((p) => p.slug === slug)?.methods ?? []), 'help']
export const sizeTotal = (i: Item) => Object.values(i.sizes).reduce((n, v) => n + (Number(v) || 0), 0)
export const totalQuantity = (i: Item) => (productOf(i)?.sized ? sizeTotal(i) : Number(i.quantity) || 0)
export const itemTitle = (i: Item) => `${productOf(i)?.name ?? ''}, ${i.method === 'help' ? 'method to be recommended' : (METHOD_NAMES[i.method] ?? '').toLowerCase()}`

function newItem(slug: string, preferMethod: string): Item {
  const product = PRODUCTS.find((p) => p.slug === slug)!
  const method = preferMethod === 'help' || product.methods.includes(preferMethod) ? preferMethod : product.methods.length === 1 ? product.methods[0] : ''
  return { key: crypto.randomUUID(), product: slug, method, quantity: '', sizes: {}, color: '', material: '', personalization: '', prints: [] }
}

/** Ticking a product adds a line; unticking removes every line of it. A method that doesn't fit is never carried over (you can't laser a shirt). */
export function toggleProduct(f: Form, slug: string): Form {
  if (f.items.some((i) => i.product === slug)) return { ...f, items: f.items.filter((i) => i.product !== slug) }
  return f.items.length >= MAX_ITEMS ? f : { ...f, items: [...f.items, newItem(slug, f.preferMethod)] }
}
/** Another line of the same product, such as the same shirt in a second color. */
export function duplicateItem(f: Form, key: string): Form {
  const at = f.items.findIndex((i) => i.key === key)
  if (at < 0 || f.items.length >= MAX_ITEMS) return f
  const copy = { ...newItem(f.items[at].product, ''), method: f.items[at].method }
  return { ...f, items: [...f.items.slice(0, at + 1), copy, ...f.items.slice(at + 1)] }
}
export const patchItem = (f: Form, key: string, change: Partial<Item>): Form => ({ ...f, items: f.items.map((i) => (i.key === key ? { ...i, ...change } : i)) })

export function validateStep(step: number, f: Form): Errors {
  const e: Errors = {}
  if (step === 1) {
    if (f.items.length === 0) e.product = 'Choose at least one thing you would like made.'
    for (const i of f.items) if (!i.method) e[`method-${i.key}`] = 'Choose a method, or "Help me choose".'
  }
  if (step === 2) {
    for (const i of f.items) {
      const total = totalQuantity(i)
      if (total < 1) e[`quantity-${i.key}`] = productOf(i)?.sized ? 'Add a quantity to at least one size.' : 'Enter how many you need.'
      if (total > 100_000) e[`quantity-${i.key}`] = 'That is more than we can take online. Please call or email us.'
    }
    if (f.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(f.dueDate)) e.dueDate = 'Enter a valid date.'
  }
  if (step === 4) {
    if (!f.contactName.trim()) e.contactName = 'Tell us your name.'
    if (f.forOrganization && !f.organization.trim()) e.organization = 'Tell us the name of the school, district or organization.'
    const email = f.contactEmail.trim()
    const phone = f.contactPhone.trim()
    if (!email && !phone) e.contactEmail = 'Give us an email or a phone number so we can reply.'
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.contactEmail = 'That email does not look right.'
    if (phone && !/^[0-9+() .-]{7,30}$/.test(phone)) e.contactPhone = 'That phone number does not look right.'
    if (f.preferredContact === 'email' && !email) e.contactEmail = 'Add an email, since you prefer email.'
    if (f.preferredContact === 'phone' && !phone) e.contactPhone = 'Add a phone number, since you prefer phone.'
  }
  return e
}

const optional = (s: string) => s.trim() || undefined

const lineOf = (i: Item, uploads: ReadonlySet<string>) => ({
  product: i.product, method: i.method, quantity: totalQuantity(i),
  sizes: productOf(i)?.sized ? Object.fromEntries(Object.entries(i.sizes).map(([k, v]) => [k, Number(v) || 0]).filter(([, v]) => Number(v) > 0)) : undefined,
  color: optional(i.color), material: optional(i.material), personalization: optional(i.personalization),
  prints: PRINT_METHODS.includes(i.method) && i.prints?.some((p) => p.location)
    ? i.prints.filter((p) => p.location).map((p) => ({ location: p.location, size: (i.method !== 'embroidery' && p.size) || undefined, artwork: uploads.has(p.artwork) ? p.artwork : undefined }))
    : undefined,
})
const someReports = (r: Record<string, ArtworkReport>) => (Object.keys(r).length > 0 ? r : undefined)

/** Asking for a figure sends only the lines and the analysis reports. Null means the form can't be priced yet. */
export function buildPreview(f: Form, uploads: ReadonlySet<string>, reports: Record<string, ArtworkReport>) {
  const parsed = estimatePreviewSchema.safeParse({ lines: f.items.map((i) => lineOf(i, uploads)), reports: someReports(reports) })
  return parsed.success ? parsed.data : null
}

/** Exactly what the server's strict schema accepts; nothing else can leave the browser. */
export function buildPayload(f: Form, uploads: ReadonlySet<string> = new Set(), reports: Record<string, ArtworkReport> = {}) {
  return inquirySubmitSchema.safeParse({
    customerKind: f.forOrganization ? f.customerKind : 'individual',
    organization: f.forOrganization ? optional(f.organization) : undefined,
    contactName: f.contactName.trim(),
    contactEmail: optional(f.contactEmail),
    contactPhone: optional(f.contactPhone),
    preferredContact: f.preferredContact || undefined,
    dueDate: optional(f.dueDate),
    designHelp: f.designHelp || undefined,
    description: optional(f.description),
    lines: f.items.map((i) => lineOf(i, uploads)),
    reports: someReports(reports),
    website: f.website || undefined,
  })
}

/** A date for people to read. Noon keeps it on the same day in every time zone. */
export const readableDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
export const describeItem = (i: Item) => `${itemTitle(i)}: ${totalQuantity(i)}`
export const summarize = (f: Form) => f.items.map(describeItem).join('. ') + '.'

// A phone can reload the page when leaving for its file picker, so the form survives in this tab only.
const KEY = 'inquiry-draft'
export type SavedFile = { id: string; name: string; bytes: number; purpose: 'artwork' | 'po'; report?: ArtworkReport | null }
export type Draft = { form: Form; token: string | null; files: SavedFile[] }
export function loadDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    const draft = raw ? JSON.parse(raw) as Draft : null
    return Array.isArray(draft?.form?.items) ? draft : null
  } catch {
    return null
  }
}
export function saveDraft(d: Draft) {
  try { sessionStorage.setItem(KEY, JSON.stringify(d)) } catch { /* private mode: the form still works, it just won't survive a reload */ }
}
export function clearDraft() {
  try { sessionStorage.removeItem(KEY) } catch { /* nothing to clear */ }
}
