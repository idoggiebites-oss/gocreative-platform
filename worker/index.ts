import { Hono } from 'hono'
import { isMaintenance } from './db/settings'
import { appRoutes } from './routes/app'

const app = new Hono<{ Bindings: Env }>().basePath('/api')

// Mounted above every route, so public routes added later are paused too (scripts/backup.ts switches this on). Before auth: the answer reveals nothing.
app.use(async (c, next) => {
  if (!/^(GET|HEAD|OPTIONS)$/.test(c.req.method) && (await isMaintenance(c.env.DB))) {
    return c.json({ error: 'Back in a few minutes: saving is paused for a backup. / Vuelve en unos minutos: el guardado está en pausa por una copia de seguridad.', code: 'maintenance' }, 503)
  }
  await next()
})

app.get('/health', async (c) => {
  const { results } = await c.env.DB.prepare('select 1 as ok').all()
  return c.json({ ok: results[0]?.ok === 1 })
})

app.route('/app', appRoutes())

export default app
