import { Hono } from 'hono'
import { accessAuth, requireRole, type AppEnv, type GetKeys } from '../auth'
import { listUsers } from '../db/users'
import { orderRoutes } from './orders'

/** Employee API, mounted at /api/app. getKeys is injectable for tests. */
export function appRoutes(getKeys?: GetKeys) {
  return new Hono<AppEnv>()
    .use(accessAuth(getKeys))
    .get('/me', (c) => c.json(c.get('user')))
    .get('/users', requireRole('owner'), async (c) => c.json({ users: await listUsers(c.env.DB) }))
    .route('/', orderRoutes())
}
