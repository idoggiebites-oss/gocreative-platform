// Where each design goes. Optional: leaving it out only means a person prices the request.
import { useRef } from 'react'
import { business } from '@shared/business'
import { PRINT_METHODS, type Garment } from '@shared/inquiry'
import { itemTitle, newPrint, patchItem, type Form, type Item, type Print } from './orderForm'
import type { Row } from './useUploads'

const SIZE_NAMES = { small: 'Small, about a left-chest logo', medium: 'Medium', large: 'Large, a full front or back' }
const MAX_PRINTS = 4

function ItemPrints({ item, artwork, set }: { item: Item; artwork: Row[]; set: (fn: (f: Form) => Form) => void }) {
  // The first row is always on screen: a question behind a button is a question nobody answers. It joins the form once something is chosen.
  const seed = useRef(newPrint())
  const prints = item.prints?.length ? item.prints : [seed.current]
  const update = (next: Print[]) => set((f) => patchItem(f, item.key, { prints: next }))
  const change = (key: string, c: Partial<Print>) => update(prints.map((p) => (p.key === key ? { ...p, ...c } : p)))
  return (
    <section className="s-item" aria-label={`Print details: ${itemTitle(item)}`}>
      <h3 className="s-display s-item-title">{itemTitle(item)}</h3>
      <div className="s-field">
        <label htmlFor={`garment-${item.key}`}>What color is the item?</label>
        <select id={`garment-${item.key}`} className="s-input" value={item.garment ?? ''} onChange={(e) => set((f) => patchItem(f, item.key, { garment: e.target.value as Garment | '' }))}>
          <option value="">Not sure yet</option>
          <option value="white">White</option>
          <option value="light">Light color</option>
          <option value="dark">Dark color</option>
        </select>
      </div>
      {prints.map((p, i) => (
        <div key={p.key} className="s-print">
          <div className="s-field">
            <label htmlFor={`where-${p.key}`}>Where on the item</label>
            <select id={`where-${p.key}`} className="s-input" value={p.location} onChange={(e) => change(p.key, { location: e.target.value })}>
              <option value="">Not sure yet</option>
              {Object.entries(business.storefront.printLocations).map(([slug, name]) => <option key={slug} value={slug}>{name}</option>)}
            </select>
          </div>
          {item.method !== 'embroidery' && (
            <div className="s-field">
              <label htmlFor={`size-${p.key}`}>Print size</label>
              <select id={`size-${p.key}`} className="s-input" value={p.size} onChange={(e) => change(p.key, { size: e.target.value })}>
                <option value="">Not sure yet</option>
                {Object.entries(SIZE_NAMES).map(([slug, name]) => <option key={slug} value={slug}>{name}</option>)}
              </select>
            </div>
          )}
          {artwork.length > 0 && (
            <div className="s-field">
              <label htmlFor={`art-${p.key}`}>Which artwork</label>
              <select id={`art-${p.key}`} className="s-input" value={artwork.some((r) => r.id === p.artwork) ? p.artwork : artwork.length === 1 ? artwork[0].id : ''} onChange={(e) => change(p.key, { artwork: e.target.value })}>
                <option value="">Choose a file</option>
                {artwork.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          )}
          {prints.length > 1 && <button type="button" className="s-link-button" aria-label={`Remove print ${i + 1}: ${itemTitle(item)}`} onClick={() => update(prints.filter((x) => x.key !== p.key))}>Remove this print</button>}
        </div>
      ))}
      {prints.length < MAX_PRINTS && <button type="button" className="s-link-button" onClick={() => update([...prints, newPrint(artwork.length === 1 ? artwork[0].id : undefined)])}>Add another print location</button>}
    </section>
  )
}

export function PrintDetails({ form, set, rows }: { form: Form; set: (fn: (f: Form) => Form) => void; rows: Row[] }) {
  const items = form.items.filter((i) => PRINT_METHODS.includes(i.method))
  if (items.length === 0) return null
  const artwork = rows.filter((r) => r.state === 'done' && r.id && r.purpose === 'artwork')
  return (
    <section className="s-stack-20" aria-labelledby="s-prints-title">
      <h2 id="s-prints-title" className="s-display s-h-next">Where should it go?</h2>
      <p className="s-body s-tight-top">Tell us what you can. If you are not sure yet, leave it and we will help you decide.</p>
      {items.map((item) => <ItemPrints key={item.key} item={item} artwork={artwork} set={set} />)}
    </section>
  )
}
