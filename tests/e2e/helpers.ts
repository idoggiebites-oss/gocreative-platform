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

