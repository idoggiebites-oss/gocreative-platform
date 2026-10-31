import { useState } from 'react'
import type { ArtworkDecisionRequest, ArtworkDesign, ArtworkVersion, OrderDetailResponse, OrderWriteResponse } from '@shared/api'
import { AUTHORIZATION_METHODS, type AuthorizationMethod } from '@shared/enums'
import { useI18n } from '@/i18n'
import { send, useSend } from '@/lib/api'
import { cn } from '@/lib/utils'
import { BTN, BTN_PRIMARY, BTN_SM, Field, FormDialog, H2, INPUT, SEC, TEXTAREA } from './form'
import { ARTWORK_TONE, Chip, MUTED } from './ui'
import { FileLinks, fmtSize, Thumb, UploadDialog } from './uploads'

type Detail = OrderDetailResponse
type Dialog = { kind: 'new' } | { kind: 'version'; design: ArtworkDesign } | { kind: 'decide'; to: ArtworkDecisionRequest['to']; version: ArtworkVersion }

const sm = cn(BTN, BTN_SM)
const smPrimary = cn(BTN, BTN_SM, BTN_PRIMARY)
const STARTED = ['in_production', 'quality_control', 'production_complete']

function DecisionDialog({ d, to, version, onClose }: { d: Detail; to: ArtworkDecisionRequest['to']; version: ArtworkVersion; onClose: () => void }) {
  const { m } = useI18n()
  const t = m.files.art
  const [expected] = useState(d.order.version)
  const [via, setVia] = useState<AuthorizationMethod | ''>('')
  const [note, setNote] = useState('')
  const approve = to === 'approved'
  const w = useSend((b: ArtworkDecisionRequest) => send<OrderWriteResponse>('PATCH', `/orders/${encodeURIComponent(d.order.number)}/artwork/${version.id}`, b))
  return (
    <FormDialog
      open onOpenChange={(o) => !o && onClose()} title={approve ? t.approveTitle : t.requestTitle} description={approve ? t.approveBody : t.requestBody}
      submitLabel={approve ? t.approve : t.requestChanges} pending={w.isPending} error={w.error} disabled={approve && !via}
      onSubmit={() => w.mutate({ to, via: approve ? (via || undefined) : undefined, note: note.trim() || null, expectedVersion: expected }, { onSuccess: onClose })}
    >
      {approve && (
        <Field label={t.method}>
          <select className={INPUT} value={via} required onChange={(e) => setVia(e.target.value as AuthorizationMethod)}>
            <option value="" disabled>{t.chooseMethod}</option>
            {AUTHORIZATION_METHODS.map((k) => <option key={k} value={k}>{m.labels.authorizationMethod[k]}</option>)}
          </select>
        </Field>
      )}
      <Field label={approve ? t.noteLabel : t.noteLabelChanges}><textarea className={TEXTAREA} rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </FormDialog>
  )
}

function VersionRow({ v, design, current, canAct, onDecide }: {
  v: ArtworkVersion; design: ArtworkDesign; current: boolean; canAct: boolean; onDecide: (to: ArtworkDecisionRequest['to']) => void
}) {
  const { m, fmt } = useI18n()
  const t = m.files.art
  const name = `${design.name ?? t.untitled} ${t.versionLabel(v.version)}`
  const decision = v.approvalStatus === 'approved' && v.approvedAt
    ? t.approvedVia[v.approvedVia ?? 'other'](fmt.date(v.approvedAt), v.approvalRecordedBy ? t.recordedBy(v.approvalRecordedBy) : '')
    : null
  return (
    <li data-version={v.version} className={cn('flex flex-wrap items-start gap-3 py-2.5', !current && 'opacity-90')}>
      <Thumb file={v.file} label={name} />
      <div className="flex min-w-[180px] flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="num font-medium">{t.versionLabel(v.version)}</span>
          {current ? <Chip tone={ARTWORK_TONE[v.approvalStatus]}>{m.labels.artworkApproval[v.approvalStatus]}</Chip> : <span className={MUTED}>{t.older}</span>}
        </div>
        <span className="min-w-0 truncate text-[13px]" title={v.file.filename ?? undefined}>{v.file.filename ?? m.common.dash} <span className={MUTED}>· {fmtSize(v.file.bytes)}</span></span>
        <span className={MUTED}>{v.file.uploadedBy ? t.uploadedBy(v.file.uploadedBy, fmt.relative(v.createdAt)) : t.uploadedAt(fmt.relative(v.createdAt))}</span>
        {current && decision && <span className="text-xs text-status-green-fg">{decision}</span>}
        {current && v.notes && <span className={MUTED}>{t.note(v.notes)}</span>}
        <FileLinks file={v.file} name={name} />
      </div>
      {current && canAct && (
        <div className="flex flex-wrap items-center gap-1.5">
          {v.approvalStatus !== 'approved' && <button type="button" className={smPrimary} onClick={() => onDecide('approved')}>{t.approve}</button>}
          {v.approvalStatus !== 'changes_requested' && <button type="button" className={sm} onClick={() => onDecide('changes_requested')}>{t.requestChanges}</button>}
        </div>
      )}
    </li>
  )
}

export function ArtworkTab({ d }: { d: Detail }) {
  const { m } = useI18n()
  const t = m.files.art
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const active = d.order.state === 'active'
  const started = STARTED.includes(d.order.productionStatus)
  const confirm = started ? { warning: t.startedWarning, label: t.startedConfirm } : undefined
  const close = () => setDialog(null)
  return (
    <div className="flex flex-col pb-3">
      <div className={SEC}>
        <h2 className={H2}>{t.title}</h2>
        <button type="button" className={smPrimary} disabled={!active} onClick={() => setDialog({ kind: 'new' })}>{t.newDesign}</button>
      </div>
      {!active && <p className={`${MUTED} px-4 pb-2`}>{t.inactive}</p>}
      {d.designs.length === 0 ? <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">{t.empty}</p> : (
        <div className="flex flex-wrap gap-x-6 gap-y-4 px-4 text-[13px]">
          {d.designs.map((design) => {
            const cur = design.versions[0]!
            return (
              <section key={design.lineageId} data-design={design.lineageId} aria-label={design.name ?? t.untitled} className="flex min-w-[min(300px,100%)] flex-1 flex-col gap-2 rounded-[10px] border border-secondary p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{design.name ?? t.untitled}</span>
                  <Chip tone={ARTWORK_TONE[cur.approvalStatus]}>{t.versionChip(cur.version, m.labels.artworkApproval[cur.approvalStatus])}</Chip>
                </div>
                <ul className="flex flex-col divide-y divide-secondary" aria-label={t.versions}>
                  {design.versions.map((v, i) => <VersionRow key={v.id} v={v} design={design} current={i === 0} canAct={active} onDecide={(to) => setDialog({ kind: 'decide', to, version: v })} />)}
                </ul>
                <div><button type="button" className={sm} disabled={!active} onClick={() => setDialog({ kind: 'version', design })}>{t.uploadVersion}</button></div>
              </section>
            )
          })}
        </div>
      )}
      {dialog?.kind === 'new' && (
        <UploadDialog d={d} onClose={close} title={t.newDesignTitle} description={t.newDesignBody} path="/artwork" allowSvg confirm={confirm} nameLabel={t.designName} />
      )}
      {dialog?.kind === 'version' && (
        <UploadDialog
          d={d} onClose={close} title={t.uploadVersionTitle(dialog.design.name ?? t.untitled)} description={t.uploadVersionBody} path="/artwork"
          query={{ lineageId: dialog.design.lineageId }} allowSvg confirm={confirm}
        />
      )}
      {dialog?.kind === 'decide' && <DecisionDialog d={d} to={dialog.to} version={dialog.version} onClose={close} />}
    </div>
  )
}
