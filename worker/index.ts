import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>().basePath('/api')

app.get('/health', async (c) => {
  const { results } = await c.env.DB.prepare('select 1 as ok').all()
  return c.json({ ok: results[0]?.ok === 1 })
})

export default app
