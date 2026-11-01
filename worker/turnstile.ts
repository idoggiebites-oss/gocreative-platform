// Server-side Turnstile check. A token is single-use, so it is spent once, to open a session.
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
export const TURNSTILE_ACTION = 'inquiry'

export async function verifyTurnstile(p: { secret: string; token: string; ip: string; hostname: string }): Promise<'ok' | 'refused' | 'unavailable'> {
  if (!p.token || p.token.length > 2048) return 'refused'
  try {
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      body: new URLSearchParams({ secret: p.secret, response: p.token, remoteip: p.ip }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return 'unavailable'
    const r = await res.json() as { success?: boolean; hostname?: string; action?: string; 'error-codes'?: string[] }
    if (r['error-codes']?.includes('internal-error')) return 'unavailable'
    return r.success === true && r.hostname === p.hostname && r.action === TURNSTILE_ACTION ? 'ok' : 'refused'
  } catch {
    return 'unavailable' // fails closed: no session opens
  }
}
