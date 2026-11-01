import { expect, type Page } from '@playwright/test'

type Made = { number: string; version: number; customerId: number }

/** A customer and an order (with a quote-able product line by default) made through the API, so a test needs no seed data. */
export async function makeOrder(page: Page, title: string, items: object[] = [{ kind: 'product', product: 'Tee', method: 'screen', quantity: 2, unitPriceCents: 1000 }], extra: object = {}): Promise<Made> {
  const api = page.request
  const c = await (await api.post('/api/app/customers', { data: { name: `Review ${title} ${Date.now()}`, kind: 'individual' } })).json()
  const res = await api.post('/api/app/orders', { data: { customerId: c.customer.id, source: 'email', title, items, ...extra } })
  expect(res.ok(), await res.text()).toBe(true)
  const o = await res.json()
  return { number: o.number, version: o.version, customerId: c.customer.id }
}

type Job = { number: string; version: number }
export const production = async (page: Page) => (await (await page.request.get('/api/app/production')).json()) as { current: Job[]; readyToStart: Job[]; completed: Job[] }

/** The shop runs one job at a time: send whatever other specs left running to quality control, which frees the slot. */
export async function clearRunning(page: Page) {
  for (const j of (await production(page)).current) {
    const res = await page.request.patch(`/api/app/orders/${j.number}/production`, { data: { to: 'quality_control', expectedVersion: j.version } })
    expect(res.ok(), await res.text()).toBe(true)
  }
}

/** An order that passes the five-item gate (accepted quote, authorization, no artwork, no purchasing, prep not required), over the API. */
export async function readyOrder(page: Page, title: string, extra: object = {}) {
  const o = await makeOrder(page, title, [{ kind: 'product', product: 'Tee', method: 'screen', quantity: 2, unitPriceCents: 1000 }], extra)
  let version = o.version
  const step = async (method: 'post' | 'patch', path: string, data: object) => {
    const res = await page.request[method](`/api/app/orders/${o.number}${path}`, { data: { ...data, expectedVersion: version } })
    expect(res.ok(), await res.text()).toBe(true)
    version = (await res.json()).version
  }
  await step('post', '/quotes', {})
  await step('patch', '/quotes/1', { to: 'accepted' })
  await step('post', '/authorization', { method: 'phone' })
  await step('patch', '', { artworkRequired: false, materialsRequired: false, confirmNoPurchasing: true })
  await step('patch', '/prep', { prepStatus: 'not_required' })
  await expect.poll(async () => (await production(page)).readyToStart.some((j) => j.number === o.number)).toBe(true)
  return o.number
}
