import { useState, type DragEvent } from 'react'
import { Camera, FileText, RotateCcw, Upload, X } from 'lucide-react'
import type { Form } from './orderForm'
import type { Row, useUploads } from './useUploads'

const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)
const line = (r: Row) => {
  const kind = r.purpose === 'po' ? 'Purchase order' : 'Artwork'
  if (r.state === 'failed') return r.error ?? 'This upload failed.'
  if (r.state === 'removing') return 'Removing'
  if (r.state === 'uploading') return `Uploading, ${Math.round(r.progress * 100)}%`
  return r.error ?? `${kind}, ${size(r.bytes)}. Uploaded.`
}

function FileRow({ row, uploads }: { row: Row; uploads: ReturnType<typeof useUploads> }) {
  return (
    <li className={`s-file${row.state === 'failed' || row.error ? ' s-file-error' : ''}`}>
      <div className="s-file-thumb">{row.preview ? <img src={row.preview} alt="" /> : <FileText aria-hidden size={24} />}</div>
      <div className="s-file-text">
        <strong>{row.name}</strong>
        <span className="s-meta">{line(row)}</span>
        {row.state === 'uploading' && (
          <div role="progressbar" aria-label={`Uploading ${row.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(row.progress * 100)} className="s-file-track">
            <div style={{ transform: `scaleX(${row.progress})` }} />
          </div>
        )}
      </div>
      <div className="s-file-actions">
        {row.state === 'failed' && row.file && <button type="button" className="s-icon-button" aria-label={`Retry ${row.name}`} onClick={() => uploads.retry(row)}><RotateCcw aria-hidden size={20} /></button>}
        <button type="button" className="s-icon-button" disabled={row.state === 'removing'} aria-label={`${row.state === 'uploading' ? 'Cancel' : 'Remove'} ${row.name}`} onClick={() => void uploads.remove(row)}><X aria-hidden size={20} /></button>
      </div>
    </li>
  )
}

export function UploadStep({ form, set, uploads }: { form: Form; set: (c: Partial<Form>) => void; uploads: ReturnType<typeof useUploads> }) {
  const [dragging, setDragging] = useState(false)
  const pick = (purpose: 'artwork' | 'po') => (e: React.ChangeEvent<HTMLInputElement>) => {
    uploads.add([...(e.target.files ?? [])], purpose)
    e.target.value = '' // the same file can be chosen again after a removal
  }
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    uploads.add([...e.dataTransfer.files], 'artwork')
  }
  const visible = uploads.rows
  const featured = [...visible].reverse().find((r) => r.preview)
  const poAttached = visible.some((r) => r.purpose === 'po')
  return (
    <div className="s-stack-20">
      <div className={`s-dropzone${dragging ? ' s-dropzone-on' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={drop}>
        <label className="s-big-choice s-big-accent s-phone-first">
          <Camera aria-hidden size={28} strokeWidth={1.8} />Take a photo
          <input className="s-visually-hidden" type="file" accept="image/*" capture="environment" onChange={pick('artwork')} />
        </label>
        <label className="s-big-choice">
          <Upload aria-hidden size={28} strokeWidth={1.8} /><span>Choose files<span className="s-desktop-inline"> or drop them here</span></span>
          {/* Listing JPEG makes iOS hand over a photo as JPEG instead of HEIC. */}
          <input className="s-visually-hidden" type="file" multiple accept=".png,.jpg,.jpeg,.pdf,.svg,image/png,image/jpeg,application/pdf,image/svg+xml" onChange={pick('artwork')} />
        </label>
      </div>
      <p className="s-meta s-tight-top">PNG, JPG, PDF or SVG. Up to 5 files, 20 MB each. A rough sketch is fine.</p>
      {uploads.notice && <p role="alert" className="s-error-block">{uploads.notice}</p>}

      {featured && (
        <figure className="s-preview">
          <img src={featured.preview} alt={`Preview of ${featured.name}`} />
          <figcaption className="s-meta">{featured.name}, {size(featured.bytes)}</figcaption>
        </figure>
      )}
      {visible.length > 0 && <ul aria-label="Your files" className="s-files">{visible.map((r) => <FileRow key={r.key} row={r} uploads={uploads} />)}</ul>}

      <label className="s-check"><input type="checkbox" checked={form.designHelp} onChange={(e) => set({ designHelp: e.target.checked })} /><span><strong>I need help with the design.</strong></span></label>

      <section className="s-org-card" aria-label="School, district or organization">
        <label className="s-check">
          <input type="checkbox" checked={form.forOrganization} disabled={poAttached} aria-describedby={poAttached ? 's-po-locked' : undefined} onChange={(e) => set({ forOrganization: e.target.checked })} />
          <span><strong>Ordering for a school, district or organization</strong></span>
        </label>
        {poAttached && <span id="s-po-locked" className="s-meta">Remove the purchase order to change this.</span>}
        {form.forOrganization && (
          <>
            <label className="s-po-choice">
              Attach a purchase order (optional)
              <input className="s-visually-hidden" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" onChange={pick('po')} />
            </label>
            <span className="s-meta">We confirm every PO with you before production. You can also send it later.</span>
          </>
        )}
      </section>
    </div>
  )
}
