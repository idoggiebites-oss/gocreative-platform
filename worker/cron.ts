// Daily cleanup of abandoned public uploads. Abandoned uploads go through here; a submitted request's files go only through a claimed deletion (inquiryDeletion.ts), never if it was converted.
import { claimExpiredInquiries } from './db/inquiries'
import * as db from './db/intake'
import { isMaintenance } from './db/settings'
import { RETENTION_SPAM_DAYS, RETENTION_UNCONVERTED_MONTHS } from './domain/inquiryConversion'
import { processClaimed } from './inquiryDeletion'
import { CLEANUP_BATCH, ORPHAN_GRACE_HOURS, ORPHAN_PAGES_PER_RUN } from './domain/intake'

export async function cleanupIntake(env: Pick<Env, 'DB' | 'FILES'>, now: Date) {
  if (await isMaintenance(env.DB)) return { skipped: true } // a backup is taking its snapshot; tomorrow is soon enough

  await db.claimExpired(env.DB)
  await claimExpiredInquiries(env.DB, RETENTION_SPAM_DAYS, RETENTION_UNCONVERTED_MONTHS)
  const inquiriesDeleted = await processClaimed(env, 'retention')
  const queued = await db.filesToDelete(env.DB, CLEANUP_BATCH)
  let deleted = 0
  if (queued.length > 0) {
    try {
      await env.FILES.delete(queued.map((f) => f.r2_key))
      await db.forgetFiles(env.DB, queued.map((f) => f.id)) // only now do the bytes come back
      deleted = queued.length
    } catch (e) {
      console.error('Intake cleanup: delete failed, will retry', e) // rows stay 'deleting'
    }
  }
  await db.sweepFinished(env.DB)

  // Objects no row names: an upload whose row is gone, or a crash between the two. Rows are read after the listing, so
  // the grace period only has to outlast a request.
  const cutoff = now.getTime() - ORPHAN_GRACE_HOURS * 3_600_000
  let cursor = await db.orphanCursor(env.DB)
  let orphans = 0
  for (let page = 0; page < ORPHAN_PAGES_PER_RUN; page++) {
    const listed = await env.FILES.list({ prefix: 'inquiries/', limit: CLEANUP_BATCH, cursor }).catch((e: unknown) => {
      if (!cursor) throw e
      return { objects: [], truncated: false as const } // a stale cursor must not break every future run: start over next time
    })
    const known = await db.knownKeys(env.DB)
    const found = listed.objects.filter((o) => o.uploaded.getTime() < cutoff && !known.has(o.key)).map((o) => o.key)
    if (found.length > 0) await env.FILES.delete(found)
    orphans += found.length
    cursor = listed.truncated ? listed.cursor : undefined
    if (!cursor) break
  }
  await db.saveOrphanCursor(env.DB, cursor) // past the last page it clears, and the next run starts over

  console.log(`Intake cleanup: ${deleted} files, ${orphans} orphans, ${inquiriesDeleted} inquiries`) // counts only
  return { deleted, orphans, inquiriesDeleted }
}
