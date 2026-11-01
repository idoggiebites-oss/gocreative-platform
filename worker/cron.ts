// Daily cleanup of abandoned public uploads. Besides the rollback cleanup in files.ts, this is the only place a public
// file is deleted, and it can't reach a submitted one: claimExpired only takes open sessions and a trigger freezes linked files.
import * as db from './db/intake'
import { isMaintenance } from './db/settings'
import { CLEANUP_BATCH, ORPHAN_GRACE_HOURS } from './domain/intake'

export async function cleanupIntake(env: Pick<Env, 'DB' | 'FILES'>, now: Date) {
  if (await isMaintenance(env.DB)) return { skipped: true } // a backup is taking its snapshot; tomorrow is soon enough

  await db.claimExpired(env.DB)
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
  const listed = await env.FILES.list({ prefix: 'inquiries/', limit: CLEANUP_BATCH })
  const known = await db.knownKeys(env.DB)
  // ponytail: one page a day, oldest keys first by name; a backlog over 500 orphans drains over several days.
  const orphans = listed.objects.filter((o) => o.uploaded.getTime() < cutoff && !known.has(o.key)).map((o) => o.key)
  if (orphans.length > 0) await env.FILES.delete(orphans)

  console.log(`Intake cleanup: ${deleted} files, ${orphans.length} orphans`) // counts only
  return { deleted, orphans: orphans.length }
}
