import { useState } from 'react'
import { FileText, ImageIcon, Upload } from 'lucide-react'
import type { OrderDetailResponse, UploadedFile } from '@shared/api'
import { useI18n } from '@/i18n'
import { checkUpload, fileUrl, uploadFile, useSend } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Check, Field, FormDialog, INPUT, LINK } from './form'

export const fmtSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

const IMG = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/tiff'])

/** A preview tile. SVG is shown only through <img>; a file the browser can't draw (TIFF in Chrome) falls back to an icon. */
export function Thumb({ file, size = 84, label }: { file: UploadedFile; size?: number; label: string }) {
  const { m } = useI18n()
  const [failed, setFailed] = useState(false)
  const box = 'flex flex-none items-center justify-center overflow-hidden rounded-lg border border-border bg-secondary text-muted-foreground'
  if (IMG.has(file.mime) && !failed) {
    return (
      <span className={box} style={{ width: size, height: size }}>
        <img src={fileUrl(file.id)} alt={label} loading="lazy" onError={() => setFailed(true)} className="size-full object-contain" />
      </span>
    )
  }
  const Icon = file.mime === 'application/pdf' ? FileText : ImageIcon
  return (
    <span className={cn(box, 'flex-col gap-1 text-[11px]')} style={{ width: size, height: size }} role="img" aria-label={label}>
      <Icon className="size-[22px]" strokeWidth={1.5} aria-hidden />
      {file.mime === 'application/pdf' ? 'PDF' : m.files.noPreview}
    </span>
  )
}

/** View (where the browser can show it inline) and Download links for one stored file. */
export function FileLinks({ file, name }: { file: UploadedFile; name: string }) {
  const { m } = useI18n()
  const inline = file.mime === 'image/png' || file.mime === 'image/jpeg' || file.mime === 'application/pdf'
  return (
    <span className="flex flex-wrap items-center gap-3 text-[13px]">
      {inline && <a className={LINK} href={fileUrl(file.id)} target="_blank" rel="noreferrer" aria-label={m.files.viewNamed(name)}>{m.files.view}</a>}
      <a className={LINK} href={fileUrl(file.id, true)} download aria-label={m.files.downloadNamed(name)}>{m.files.download}</a>
    </span>
  )
}

/** A file picker that is also a drop target. The real input stays focusable (visually hidden), so the keyboard works. */
export function DropZone({ file, onFile, accept, hint }: { file: File | null; onFile: (f: File) => void; accept: string; hint: string }) {
  const { m } = useI18n()
  const [over, setOver] = useState(false)
  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
      className={cn(
        'flex cursor-pointer flex-col items-center gap-1 rounded-[10px] border border-dashed border-input bg-header px-4 py-5 text-center text-[13px] hover:bg-secondary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40',
        over && 'border-primary bg-secondary',
      )}
    >
      <input type="file" accept={accept} className="sr-only" aria-label={m.files.upload.fileLabel} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
      <Upload className="size-[18px] text-muted-foreground" strokeWidth={1.75} aria-hidden />
      {file ? <><b className="max-w-full truncate font-medium">{file.name}</b><span className="text-xs text-muted-foreground">{fmtSize(file.size)} · {m.files.upload.change}</span></> : <span>{m.files.upload.drop}</span>}
      <span className="text-xs text-muted-foreground">{hint}</span>
    </label>
  )
}

/**
 * A dialog that uploads one file to an order endpoint. The order version is captured when the dialog opens (it is mounted
 * only while open) and sent as expectedVersion. `confirm` adds a required acknowledgement before Upload is enabled.
 */
export function UploadDialog({ d, onClose, title, description, path, query, allowSvg, confirm, nameLabel }: {
  d: OrderDetailResponse; onClose: () => void; title: string; description: string; path: string
  query?: Record<string, string | number | undefined>; allowSvg: boolean; confirm?: { warning: string; label: string }
  /** When set, shows an optional design-name field (sent as designName). */
  nameLabel?: string
}) {
  const { m } = useI18n()
  const [version] = useState(d.order.version)
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [ack, setAck] = useState(false)
  const up = useSend((f: File) => uploadFile(`/orders/${encodeURIComponent(d.order.number)}${path}`, f, { ...query, designName: name.trim(), expectedVersion: version }))
  const pick = (f: File) => {
    const bad = checkUpload(f, allowSvg)
    setFile(f)
    setProblem(bad === 'too_large' ? m.files.upload.tooLarge : bad === 'bad_type' ? (allowSvg ? m.files.upload.badType : m.files.upload.badTypePo) : null)
  }
  const accept = allowSvg ? '.png,.jpg,.jpeg,.tif,.tiff,.pdf,.svg' : '.png,.jpg,.jpeg,.tif,.tiff,.pdf'
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={title} description={description} submitLabel={m.files.upload.upload} pendingLabel={m.files.upload.uploading}
      pending={up.isPending} error={up.error} disabled={!file || !!problem || (!!confirm && !ack)}
      onSubmit={() => file && !problem && up.mutate(file, { onSuccess: onClose })}
    >
      {nameLabel && <Field label={nameLabel}><input className={INPUT} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></Field>}
      <DropZone file={file} onFile={pick} accept={accept} hint={allowSvg ? m.files.upload.artworkTypes : m.files.upload.poTypes} />
      {problem && <p role="alert" className="text-xs text-status-red-fg">{problem}</p>}
      {confirm && (
        <>
          <p role="status" className="rounded-[7px] bg-status-amber px-2.5 py-2 text-[12.5px] text-status-amber-fg">{confirm.warning}</p>
          <Check checked={ack} onChange={setAck}>{confirm.label}</Check>
        </>
      )}
    </FormDialog>
  )
}
