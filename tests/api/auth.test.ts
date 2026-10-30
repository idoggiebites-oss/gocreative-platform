import { beforeAll, describe, expect, test } from 'vitest'
import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { appRoutes } from '../../worker/routes/app'
import type { AppEnv, Jwk } from '../../worker/auth'
import realApp from '../../worker/index'
import { createTestD1 } from './d1'

const TEAM = 'testteam.cloudflareaccess.com'
const AUD = 'test-aud-tag'
const { db, sqlite } = createTestD1()
sqlite.exec(`INSERT INTO users (id, email, name, role, active) VALUES
  (1, 'owner1@example.com', 'Owner One', 'owner', 1),
  (2, 'staff1@example.com', 'Staff One', 'staff', 1),
  (3, 'gone@example.com', 'Former', 'staff', 0)`)

const env = (over: Partial<Env> = {}): Partial<Env> => ({ DB: db, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM, ...over })

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as { privateKey: CryptoKey; publicKey: CryptoKey }
  const priv = { ...((await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey), kid, alg: 'RS256' }
  const pub = { ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey), kid, alg: 'RS256' }
  return { priv, pub }
}

let good: Awaited<ReturnType<typeof keyPair>>
let rogue: Awaited<ReturnType<typeof keyPair>>
let app: Hono<AppEnv>
const refreshes: boolean[] = []

beforeAll(async () => {
  good = await keyPair('good')
  rogue = await keyPair('rogue')
  const getKeys = async (domain: string, refresh: boolean): Promise<Jwk[]> => {
    expect(domain).toBe(TEAM)
    refreshes.push(refresh)
    return [good.pub]
  }
  app = new Hono<AppEnv>().route('/api/app', appRoutes(getKeys))
})

const now = () => Math.floor(Date.now() / 1000)
const token = (claims: Record<string, unknown> = {}, key = good.priv) =>
  sign({ aud: [AUD], iss: `https://${TEAM}`, email: 'owner1@example.com', iat: now(), exp: now() + 600, ...claims }, key)

const get = (path: string, jwt?: string, e: Partial<Env> = env(), host = 'gocreative.example.workers.dev') =>
  app.request(`https://${host}/api/app${path}`, { headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} }, e)

const expectError = async (res: Response, status: number, error: string) => {
  expect(res.status).toBe(status)
  expect(await res.json()).toEqual({ error })
}

describe('401 unauthenticated', () => {
  test('no header', async () => expectError(await get('/me'), 401, 'unauthenticated'))
  test('garbage token', async () => expectError(await get('/me', 'not.a.jwt'), 401, 'unauthenticated'))
  test('signed by a different key with an unknown kid', async () => {
    refreshes.length = 0
    await expectError(await get('/me', await token({}, rogue.priv)), 401, 'unauthenticated')
    expect(refreshes).toEqual([false, true]) // refetched once on unknown kid
  })
  test('signed by a different key claiming the known kid', async () =>
    expectError(await get('/me', await token({}, { ...rogue.priv, kid: 'good' })), 401, 'unauthenticated'))
  test('expired', async () => expectError(await get('/me', await token({ exp: now() - 10 })), 401, 'unauthenticated'))
  test('no exp claim', async () => expectError(await get('/me', await token({ exp: undefined })), 401, 'unauthenticated'))
  test('wrong aud', async () => expectError(await get('/me', await token({ aud: ['other'] })), 401, 'unauthenticated'))
  test('wrong iss', async () =>
    expectError(await get('/me', await token({ iss: 'https://evil.cloudflareaccess.com' })), 401, 'unauthenticated'))
  test('HS256 token', async () => {
    const hs = await sign({ aud: [AUD], iss: `https://${TEAM}`, email: 'owner1@example.com', exp: now() + 600 }, 'secret')
    await expectError(await get('/me', hs), 401, 'unauthenticated')
  })
})

describe('403 forbidden', () => {
  test('unknown email', async () =>
    expectError(await get('/me', await token({ email: 'stranger@example.com' })), 403, 'forbidden'))
  test('inactive user', async () => expectError(await get('/me', await token({ email: 'gone@example.com' })), 403, 'forbidden'))
  test('staff on /users', async () =>
    expectError(await get('/users', await token({ email: 'staff1@example.com' })), 403, 'forbidden'))
})

describe('authenticated', () => {
  test('email differing only in case → /me', async () => {
    const res = await get('/me', await token({ email: 'OWNER1@Example.COM' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 1, email: 'owner1@example.com', name: 'Owner One', role: 'owner' })
  })
  test('aud as a plain string is accepted', async () =>
    expect((await get('/me', await token({ aud: AUD }))).status).toBe(200))
  test('staff on /me', async () =>
    expect(await (await get('/me', await token({ email: 'staff1@example.com' }))).json()).toMatchObject({ role: 'staff' }))
  test('owner on /users', async () => {
    const res = await get('/users', await token())
    expect(res.status).toBe(200)
    const { users } = (await res.json()) as { users: Record<string, unknown>[] }
    expect(users).toHaveLength(3)
    for (const u of users) expect(Object.keys(u).sort()).toEqual(['active', 'email', 'id', 'name', 'role'])
  })
})

describe('config and dev bypass', () => {
  test('DEV_AUTH_EMAIL on a non-local host is not a bypass', async () => {
    const res = await get('/me', undefined, env({ DEV_AUTH_EMAIL: 'owner1@example.com' }), 'example.com')
    expect(res.status).toBe(401)
  })
  test('DEV_AUTH_EMAIL on a non-local host without Access config → 500', async () => {
    const e = env({ DEV_AUTH_EMAIL: 'owner1@example.com', ACCESS_AUD: undefined })
    await expectError(await get('/me', undefined, e, 'example.com'), 500, 'auth_not_configured')
  })
  for (const host of ['localhost', '127.0.0.1']) {
    test(`DEV_AUTH_EMAIL on ${host}`, async () => {
      const e = { DB: db, DEV_AUTH_EMAIL: 'owner1@example.com' }
      const res = await get('/me', undefined, e, `${host}:5173`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ email: 'owner1@example.com', role: 'owner' })
    })
  }
  test('DEV_AUTH_EMAIL still needs an active user', async () =>
    expectError(await get('/me', undefined, { DB: db, DEV_AUTH_EMAIL: 'gone@example.com' }, 'localhost'), 403, 'forbidden'))
  test('ACCESS_AUD unset, no bypass → 500', async () =>
    expectError(await get('/me', await token(), env({ ACCESS_AUD: undefined })), 500, 'auth_not_configured'))
  test('ACCESS_TEAM_DOMAIN unset, no bypass → 500', async () =>
    expectError(await get('/me', await token(), env({ ACCESS_TEAM_DOMAIN: undefined })), 500, 'auth_not_configured'))
})

describe('worker/index.ts mounting', () => {
  test('/api/health stays public', async () => {
    const res = await realApp.request('https://x.workers.dev/api/health', {}, { DB: db })
    expect(await res.json()).toEqual({ ok: true })
  })
  test('/api/app/* is behind auth in the real app', async () => {
    const res = await realApp.request('https://x.workers.dev/api/app/me', {}, env())
    await expectError(res, 401, 'unauthenticated')
  })
})
