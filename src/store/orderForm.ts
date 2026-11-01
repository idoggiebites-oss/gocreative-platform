// The order form's data and rules. The server's schema (shared/inquiry.ts) stays the authority: this builds what it
// expects and gives friendly per-field messages first.
import { business } from '@shared/business'
import { inquirySubmitSchema } from '@shared/inquiry'

export type Product = { slug: string; name: string; hint: string; methods: readonly string[]; sized: boolean }
export const PRODUCTS: readonly Product[] = business.storefront.products
export const SIZES: readonly string[] = business.sizes
export const METHOD_NAMES: Record<string, string> = {
  screen: 'Screen printing', embroidery: 'Embroidery', dtg: 'Direct to garment', laser_engrave: 'Laser engraving', laser_cut: 'Laser cutting', other: 'Other', help: 'Help me choose',
}

export type Form = {
  product: string; method: string; quantity: string; sizes: Record<string, string>
  color: string; material: string; personalization: string; notes: string; dueDate: string
  designHelp: boolean; forOrganization: boolean; customerKind: 'district' | 'organization'
  organization: string; contactName: string; contactEmail: string; contactPhone: string; preferredContact: '' | 'email' | 'phone'
  website: string
}
export const EMPTY_FORM: Form = {
  product: '', method: '', quantity: '', sizes: {}, color: '', material: '', personalization: '', notes: '', dueDate: '',
  designHelp: false, forOrganization: false, customerKind: 'district', organization: '', contactName: '', contactEmail: '', contactPhone: '', preferredContact: '', website: '',
}
export type Errors = Partial<Record<string, string>>

export const productOf = (f: Form) => PRODUCTS.find((p) => p.slug === f.product)
export const methodsFor = (slug: string) => [...(PRODUCTS.find((p) => p.slug === slug)?.methods ?? []), 'help']
export const sizeTotal = (f: Form) => Object.values(f.sizes).reduce((n, v) => n + (Number(v) || 0), 0)
export const totalQuantity = (f: Form) => (productOf(f)?.sized ? sizeTotal(f) : Number(f.quantity) || 0)

/** Changing the product keeps a method that still fits, and picks the only one if there is just one (you can't laser a shirt). */
export function chooseProduct(f: Form, slug: string): Form {
  const product = PRODUCTS.find((p) => p.slug === slug)!
  const fits = f.method === 'help' || product.methods.includes(f.method)
  return {
    ...f, product: slug,
    method: fits ? f.method : product.methods.length === 1 ? product.methods[0] : '',
    sizes: product.sized ? f.sizes : {},
    quantity: product.sized ? '' : f.quantity,
    color: slug === 'trophies' || slug === 'engraved' ? '' : f.color,
    material: slug === 'engraved' ? f.material : '',
    personalization: slug === 'trophies' ? f.personalization : '',
  }
}

export function validateStep(step: number, f: Form): Errors {
  const e: Errors = {}
  if (step === 1) {
    if (!f.product) e.product = 'Choose what you would like made.'
    if (!f.method) e.method = 'Choose a method, or "Help me choose".'
  }
  if (step === 2) {
    const total = totalQuantity(f)
    if (total < 1) e.quantity = productOf(f)?.sized ? 'Add a quantity to at least one size.' : 'Enter how many you need.'
    if (total > 100_000) e.quantity = 'That is more than we can take online. Please call or email us.'
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

/** Exactly what the server's strict schema accepts; nothing else can leave the browser. */
export function buildPayload(f: Form) {
  const sized = productOf(f)?.sized
  const sizes = Object.fromEntries(Object.entries(f.sizes).map(([k, v]) => [k, Number(v) || 0]).filter(([, v]) => Number(v) > 0))
  return inquirySubmitSchema.safeParse({
    customerKind: f.forOrganization ? f.customerKind : 'individual',
    organization: f.forOrganization ? optional(f.organization) : undefined,
    contactName: f.contactName.trim(),
    contactEmail: optional(f.contactEmail),
    contactPhone: optional(f.contactPhone),
    preferredContact: f.preferredContact || undefined,
    dueDate: optional(f.dueDate),
    designHelp: f.designHelp || undefined,
    lines: [{
      product: f.product, method: f.method, quantity: totalQuantity(f), sizes: sized ? sizes : undefined,
      color: optional(f.color), material: optional(f.material), personalization: optional(f.personalization), notes: optional(f.notes),
    }],
    website: f.website || undefined,
  })
}

export function summarize(f: Form) {
  const p = productOf(f)
  const method = METHOD_NAMES[f.method] ?? ''
  return `${p?.name ?? ''}, ${f.method === 'help' ? 'method to be recommended' : method.toLowerCase()}. ${totalQuantity(f)} total.`
}

// A phone can reload the page when the camera app opens, so the form survives in this tab only.
const KEY = 'inquiry-draft'
export type SavedFile = { id: string; name: string; bytes: number; purpose: 'artwork' | 'po' }
export type Draft = { form: Form; token: string | null; files: SavedFile[] }
export function loadDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? { ...JSON.parse(raw) as Draft } : null
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
