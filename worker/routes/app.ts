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
import { inquiryRoutes } from './inquiries'
import { pricingRoutes } from './pricing'
import { sameOriginWrites } from '../sameOrigin'

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
    .route('/', inquiryRoutes())
    .route('/', pricingRoutes())
}
