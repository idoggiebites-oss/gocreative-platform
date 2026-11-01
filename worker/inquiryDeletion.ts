// Deletes claimed inquiries. The journal entry is written first and lives outside D1, so restoring an older database can
// replay it and a deleted request stays deleted (notes/backup-restore.md). It holds ids, keys and hashes: no personal data.
import * as db from './db/inquiries'

export const JOURNAL_PREFIX = '_journal/deletions/'
const JOURNAL_BATCH = 100

async function deleteClaimed(env: Pick<Env, 'DB' | 'FILES'>, c: db.ClaimedInquiry, reason: string, actorId: number | null) {
  const files = await db.claimedFiles(env.DB, c.id)
  // Two runs can overlap (an owner's delete and the cron). The key is fixed by the claim and the write is create-only, so the first
  // entry, the one with the full file list, is the one that stays. Later runs find the rows gone and change nothing.
  const key = `${JOURNAL_PREFIX}${c.deleting_at.replace(/[:.]/g, '-')}-inquiry-${c.id}.json`
  if (!(await env.FILES.head(key))) await env.FILES.put(key, JSON.stringify({
    kind: 'inquiry', inquiryId: c.id, submissionId: c.submission_id, at: c.deleting_at, reason,
    files: files.map((f) => ({ fileId: f.file_id, r2Key: f.r2_key, sha256: f.sha256 })),
  }), { httpMetadata: { contentType: 'application/json' }, onlyIf: { etagDoesNotMatch: '*' } })
  await db.markClaimedFilesDeleting(env.DB, c.id)
  if (files.length > 0) await env.FILES.delete(files.map((f) => f.r2_key))
  await db.removeClaimedRows(env.DB, c, files.flatMap((f) => (f.file_id === null ? [] : [f.file_id])), reason, actorId)
}

/** Works through what is claimed. A failure leaves the claim in place for the next run, and the inquiry stays out of the queue. */
export async function processClaimed(env: Pick<Env, 'DB' | 'FILES'>, reason: string, actorId: number | null = null) {
  let deleted = 0
  for (const c of await db.listClaimed(env.DB, JOURNAL_BATCH)) {
    try {
      await deleteClaimed(env, c, reason, actorId)
      deleted++
    } catch (e) {
      console.error('Inquiry deletion failed, will retry', c.id, e) // ids only
    }
  }
  return deleted
}
