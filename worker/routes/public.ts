// The public API, /api/public/*. Separate from the staff routes on purpose (STOREFRONT_PLAN §0b.5): it shares only the
// low-level streaming and sniffing, and every response is an explicit object holding what the customer just sent.
// The session token travels in the Authorization header, not the path, so it stays out of request logs.
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppEnv } from '../auth'
import { business } from '../../shared/business'
import { FILE_PURPOSES, inquirySubmitSchema } from '../../shared/inquiry'
import * as db from '../db/intake'
import { isIntakeClosed } from '../db/settings'
import { FILE_MAX_BYTES, JSON_MAX_BYTES, SESSION_HOURS, newRef, usageDay } from '../domain/intake'
import { isDefiniteRollback, storeUpload, type FileKind } from '../files'
import { sameOriginWrites } from '../sameOrigin'
import { verifyTurnstile } from '../turnstile'

type Env_ = AppEnv // no user is ever set here: this just matches the shared upload helper
const fail = (c: Context, status: 400 | 401 | 404 | 409 | 410 | 413 | 429 | 503, code: string, error: string) => c.json({ error, code }, status)

// A PO is a scan or a PDF (matches the staff rule); public uploads take no TIFF.
const PUBLIC_KINDS: Record<(typeof FILE_PURPOSES)[number], readonly FileKind[]> = { artwork: ['png', 'jpeg', 'pdf', 'svg'], po: ['png', 'jpeg', 'pdf'] }

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('')
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
const hashIp = async (ip: string, salt: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip)))
}
const base64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const clientIp = (c: Context) => c.req.header('cf-connecting-ip') ?? 'unknown'

const intakeOpen: MiddlewareHandler<Env_> = async (c, next) =>
  (await isIntakeClosed(c.env.DB)) ? fail(c, 503, 'intake_closed', 'We are not taking online requests right now. Please call or email us.') : next()

const jsonCap = bodyLimit({ maxSize: JSON_MAX_BYTES, onError: (c) => c.json({ error: 'Request body too large', code: 'body_too_large' }, 413) })

const session = async (c: Context<Env_>) => {
  const token = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(c.req.header('authorization') ?? '')?.[1]
  return token ? db.findSession(c.env.DB, await sha256(token)) : null
}
const badSession = (c: Context) => fail(c, 401, 'session_invalid', 'Your session has ended. Please start again.')

async function readJson(c: Context) {
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}

/** Gives a reservation back: certain the object is gone, or queued for cron if not. */
async function release(c: Context<Env_>, id: string, key: string) {
  try {
    await c.env.FILES.delete(key)
    await db.markFailed(c.env.DB, id)
  } catch {
    await db.markDeleting(c.env.DB, id).catch(() => {}) // still reserved at worst; expiry claims it
  }
}

export function publicRoutes() {
  return new Hono<Env_>()
    .use(async (c, next) => {
      if (!business.modules.storefront) return c.notFound()
      await next()
      c.header('Cache-Control', 'no-store')
    })
    .use(sameOriginWrites)
    .get('/status', async (c) => c.json({ open: !(await isIntakeClosed(c.env.DB)) }))

    .post('/submissions', intakeOpen, jsonCap, async (c) => {
      const secret = c.env.TURNSTILE_SECRET
      const salt = c.env.IP_HASH_SALT
      if (!secret || !salt) return fail(c, 503, 'intake_closed', 'We are not taking online requests right now. Please call or email us.') // fail closed
      const body = await readJson(c) as { turnstileToken?: unknown } | undefined
      const ip = clientIp(c)
      const proof = typeof body?.turnstileToken === 'string' ? body.turnstileToken : ''
      const verified = await verifyTurnstile({ secret, token: proof, ip, hostname: new URL(c.req.url).hostname })
      if (verified === 'unavailable') return fail(c, 503, 'verification_unavailable', 'Please try again in a moment.')
      if (verified === 'refused') return fail(c, 400, 'verification_failed', 'We could not verify your browser. Please try again.')

      const token = base64url(crypto.getRandomValues(new Uint8Array(32)))
      const now = new Date()
      const opened = await db.openSession(c.env.DB, {
        id: crypto.randomUUID(), tokenHash: await sha256(token), ipHash: await hashIp(ip, salt),
        expiresAt: new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString(), day: usageDay(now),
      })
      if (!opened) return fail(c, 429, 'busy', 'We are getting a lot of requests. Please try again later, or call or email us.')
      return c.json({ token }, 201)
    })

    .post('/submissions/files', intakeOpen, async (c) => {
      const s = await session(c)
      if (!s) return badSession(c)
      if (s.status !== 'open') return fail(c, 409, 'session_closed', 'This request has already been sent.')
      if (s.expired) return fail(c, 410, 'session_expired', 'Your session has ended. Please start again.')
      const purpose = FILE_PURPOSES.find((k) => k === c.req.header('x-file-purpose'))
      if (!purpose) return fail(c, 400, 'invalid_request', 'Say what this file is')
      const length = Number(c.req.header('content-length'))
      if (!Number.isSafeInteger(length) || length <= 0) return fail(c, 400, 'invalid_request', 'Content-Length is required')
      if (length > FILE_MAX_BYTES) return fail(c, 413, 'file_too_large', `File is larger than ${FILE_MAX_BYTES / 2 ** 20} MB`)

      const id = crypto.randomUUID()
      const key = `inquiries/${s.id}/${id}`
      if (!(await db.reserveFile(c.env.DB, { id, submissionId: s.id, r2Key: key, kind: purpose, bytes: length, day: usageDay(new Date()) }))) {
        return fail(c, 429, 'upload_limit', 'This upload would go over the limit for one request.')
      }
      let stored
      try {
        stored = await storeUpload(c, { key, maxBytes: FILE_MAX_BYTES }, PUBLIC_KINDS[purpose], (file) => db.settleFile(c.env.DB, id, file, usageDay(new Date())))
      } catch (e) {
        // The settle may have committed, so the object can't be deleted here. Only a row still reserved is queued.
        await db.markDeleting(c.env.DB, id, ['reserved']).catch(() => {})
        throw e
      }
      if ('response' in stored) {
        await release(c, id, key)
        return stored.response
      }
      if (stored.result === null) {
        await db.markDeleting(c.env.DB, id, ['reserved']) // settled too late; storeUpload tried the delete, cron confirms it
        return (await session(c))?.status === 'open'
          ? fail(c, 409, 'upload_too_slow', 'That file took too long to upload. Please try again on a better connection.')
          : fail(c, 409, 'session_closed', 'This request has already been sent.')
      }
      return c.json({ id, filename: stored.result.filename, bytes: stored.result.bytes }, 201)
    })

    .delete('/submissions/files/:id', intakeOpen, async (c) => {
      const s = await session(c)
      if (!s) return badSession(c)
      if (s.status !== 'open') return fail(c, 409, 'session_closed', 'This request has already been sent.')
      const id = c.req.param('id')
      const key = await db.claimStored(c.env.DB, id, s.id)
      if (!key) return fail(c, 404, 'not_found', 'No such file')
      try {
        await c.env.FILES.delete(key)
        await db.markFailed(c.env.DB, id, ['deleting'])
      } catch (e) {
        console.error('Inquiry file delete failed; cron retries', e) // the row is 'deleting', so nothing is lost
      }
      return c.json({ ok: true })
    })

    .post('/submissions/submit', intakeOpen, jsonCap, async (c) => {
      const s = await session(c)
      if (!s) return badSession(c)
      // A retry after a lost response or a double-tap: same answer, nothing new.
      const already = s.status === 'submitted' ? await db.findRef(c.env.DB, s.id) : null
      if (already) return c.json({ ref: already })
      if (s.status !== 'open' || s.expired) return fail(c, 410, 'session_expired', 'Your session has ended. Please start again.')

      const parsed = inquirySubmitSchema.safeParse(await readJson(c))
      if (!parsed.success) return fail(c, 400, 'invalid_request', 'Please check the form and try again.') // no echo of what was sent
      const { website, ...input } = parsed.data
      if (!c.env.IP_HASH_SALT) return fail(c, 503, 'intake_closed', 'We are not taking online requests right now. Please call or email us.')
      const ipHash = await hashIp(clientIp(c), c.env.IP_HASH_SALT)

      const ref = newRef()
      let submitted: boolean
      try {
        submitted = await db.submitInquiry(c.env.DB, { submissionId: s.id, ref, ipHash, input, spam: Boolean(website) }) // a filled honeypot looks accepted
      } catch (e) {
        if (!isDefiniteRollback(e)) throw e
        // A parallel submit got there first, or (one in a billion) the ref collided. The retry answers either way.
        const raced = await db.findRef(c.env.DB, s.id)
        if (raced) return c.json({ ref: raced })
        throw e
      }
      if (submitted) return c.json({ ref }, 201)
      // Nothing committed. Work out why, for the customer: the conditions were checked atomically above.
      const raced = await db.findRef(c.env.DB, s.id)
      if (raced) return c.json({ ref: raced })
      const files = await db.sessionFileKinds(c.env.DB, s.id)
      if (files.some((f) => f.live)) return fail(c, 409, 'uploads_in_progress', 'Your files are still uploading.')
      if (input.customerKind === 'individual' && files.some((f) => f.kind === 'po' && f.status === 'stored')) {
        return fail(c, 400, 'po_not_accepted', 'Purchase orders are for schools, districts and organizations.')
      }
      return fail(c, 410, 'session_expired', 'Your session has ended. Please start again.')
    })
}
