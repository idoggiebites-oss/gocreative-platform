import type { MiddlewareHandler } from 'hono'
import { decode, verify } from 'hono/jwt'
import { findActiveUserByEmail, type AppUser } from './db/users'
import type { Role } from '../shared/enums'

export type AppEnv = { Bindings: Env; Variables: { user: AppUser } }
export type Jwk = JsonWebKey & { kid?: string }
/** refresh=true asks for a fresh fetch (unknown kid, e.g. after Access rotates keys). */
export type GetKeys = (teamDomain: string, refresh: boolean) => Promise<Jwk[]>

const KEY_TTL_MS = 5 * 60_000
// A forced refresh is ignored while the cache is younger than this, so tokens with made-up kids can't hammer the certs URL.
const MIN_REFRESH_MS = 10_000
let cache: { domain: string; keys: Jwk[]; at: number } | undefined

export const fetchAccessKeys: GetKeys = async (teamDomain, refresh) => {
  const age = cache?.domain === teamDomain ? Date.now() - cache.at : Infinity
  if (cache && age < (refresh ? MIN_REFRESH_MS : KEY_TTL_MS)) return cache.keys
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`)
  const { keys } = (await res.json()) as { keys: Jwk[] }
  if (!Array.isArray(keys)) throw new Error('Access certs response has no keys array')
  cache = { domain: teamDomain, keys, at: Date.now() }
  return keys
}

/** Returns the verified email, or null for any missing/invalid/expired/foreign token. */
async function verifyAccessJwt(token: string | undefined, aud: string, teamDomain: string, getKeys: GetKeys) {
  if (!token) return null
  let kid: string | undefined
  try {
    kid = decode(token).header.kid
  } catch {
    return null
  }
  if (!kid) return null
  const key =
    (await getKeys(teamDomain, false)).find((k) => k.kid === kid) ??
    (await getKeys(teamDomain, true)).find((k) => k.kid === kid)
  if (!key) return null
  try {
    // alg pinned to RS256 (no alg confusion). Hono checks exp/nbf/iat, iss, and aud (string or array).
    const payload = await verify(token, key, { alg: 'RS256', aud, iss: `https://${teamDomain}` })
    if (typeof payload.exp !== 'number' || typeof payload.email !== 'string' || !payload.email) return null
    return payload.email
  } catch {
    return null
  }
}

const isLocalHost = (url: string) => ['localhost', '127.0.0.1'].includes(new URL(url).hostname)

/**
 * Cloudflare Access sits in front of /api/app/*, but the Worker re-verifies the
 * JWT so a misconfigured Access policy still can't reach the API. Identity comes
 * from Access; the role comes from our users table.
 */
export function accessAuth(getKeys: GetKeys = fetchAccessKeys): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { ACCESS_AUD, ACCESS_TEAM_DOMAIN, DEV_AUTH_EMAIL } = c.env
    let email: string | null
    if (DEV_AUTH_EMAIL && isLocalHost(c.req.url)) {
      email = DEV_AUTH_EMAIL
    } else {
      // Fail closed: missing config is an error, never an open door.
      if (!ACCESS_AUD || !ACCESS_TEAM_DOMAIN) return c.json({ error: 'auth_not_configured' }, 500)
      const teamDomain = ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '')
      email = await verifyAccessJwt(c.req.header('Cf-Access-Jwt-Assertion'), ACCESS_AUD, teamDomain, getKeys)
      if (!email) return c.json({ error: 'unauthenticated' }, 401)
    }
    const user = await findActiveUserByEmail(c.env.DB, email)
    if (!user) return c.json({ error: 'forbidden' }, 403)
    c.set('user', user)
    await next()
  }
}

export function requireRole(role: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('user').role !== role) return c.json({ error: 'forbidden' }, 403)
    await next()
  }
}
