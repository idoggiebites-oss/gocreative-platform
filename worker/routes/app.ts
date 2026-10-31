import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { accessAuth, requireRole, type AppEnv, type GetKeys } from '../auth'
import { listUsers } from '../db/users'
import { customerRoutes } from './customers'
import { orderRoutes } from './orders'
import { orderWriteRoutes } from './orderWrites'
import { artworkRoutes } from './artwork'
import { purchasingRoutes } from './purchasing'
import { productionRoutes } from './production'
import { pickupRoutes } from './pickups'
import { paymentRoutes } from './payments'
import { fileRoutes } from '../files'

/**
 * Writes must come from this site (Codex Phase 2 security review). The Access cookie rides along on a cross-site
 * request, so a valid JWT proves who, not intent: any unsafe method whose Origin is another site, or whose
 * Sec-Fetch-Site says cross-site/same-site, is refused before auth. Browsers always send Origin on a cross-origin
 * POST; requests without either header (curl, tests) aren't a browser riding a cookie.
 */
const sameOriginWrites: MiddlewareHandler = async (c, next) => {
  if (!/^(GET|HEAD|OPTIONS)$/.test(c.req.method)) {
    const origin = c.req.header('origin')
    const site = c.req.header('sec-fetch-site')
    if ((origin && origin !== new URL(c.req.url).origin) || (site && site !== 'same-origin' && site !== 'none')) {
      return c.json({ error: 'Cross-site request refused', code: 'cross_site_request' }, 403)
    }
  }
  await next()
}
// Every body except the two streamed uploads is capped before it is read (uploads stream under their own 50 MB limit
// in files.ts). By path, not Content-Type: a JSON route parses whatever it is sent.
const BODY_LIMIT = 256 * 1024
const UPLOAD = /\/orders\/[^/]+\/(artwork|purchase-orders\/[^/]+\/documents)$/
const jsonLimit: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'POST' && UPLOAD.test(c.req.path)) return next()
  return bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'Request body too large', code: 'body_too_large' }, 413) })(c, next)
}

/** Employee API, mounted at /api/app. getKeys is injectable for tests. */
export function appRoutes(getKeys?: GetKeys) {
  return new Hono<AppEnv>()
    .use(sameOriginWrites)
    .use(jsonLimit)
    .use(accessAuth(getKeys))
    .get('/me', (c) => c.json(c.get('user')))
    .get('/users', requireRole('owner'), async (c) => c.json({ users: await listUsers(c.env.DB) }))
    .route('/', orderRoutes())
    .route('/', customerRoutes())
    .route('/', orderWriteRoutes())
    .route('/', artworkRoutes())
    .route('/', purchasingRoutes())
    .route('/', productionRoutes())
    .route('/', pickupRoutes())
    .route('/', paymentRoutes())
    .route('/', fileRoutes())
}
