import { Hono } from 'hono'
import { appRoutes } from './routes/app'

const app = new Hono<{ Bindings: Env }>().basePath('/api')

app.get('/health', async (c) => {
  const { results } = await c.env.DB.prepare('select 1 as ok').all()
  return c.json({ ok: results[0]?.ok === 1 })
})

app.route('/app', appRoutes())

export default app
