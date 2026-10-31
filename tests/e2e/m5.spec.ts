import { expect, test, type Page } from '@playwright/test'
import { makeOrder } from './helpers.ts'
import { reseed } from './prepare.ts'

// M5: the order's Pickup and Payments tabs, the Payments page, and the dashboard's Ready for pickup and Outstanding payments.
// Orders are made and taken to production_complete over the API; each test then does the thing it is about in the UI.
test.afterAll(() => {
  reseed()
})

const dialog = (page: Page) => page.getByRole('dialog')
const fits = async (page: Page) => {
  const scroll = (await page.evaluate('document.documentElement.scrollWidth')) as number
  const width = (await page.evaluate('window.innerWidth')) as number
  expect(scroll).toBeLessThanOrEqual(width)
}
const setLang = (page: Page, lang: 'en' | 'es') => page.evaluate((l) => localStorage.setItem('lang', l), lang)
const desktopOnly = (info: { project: { name: string } }) => test.skip(info.project.name === 'phone')

type Job = { number: string; version: number }
const production = async (page: Page) => (await (await page.request.get('/api/app/production')).json()) as { current: Job[]; readyToStart: Job[] }
const orderState = async (page: Page, n: string) => (await (await page.request.get(`/api/app/orders/${n}`)).json()).order as { state: string; version: number }
const paymentsOf = async (page: Page, n: string) => (await (await page.request.get(`/api/app/orders/${n}/payments`)).json()) as {
  version: number; payments: { id: number; voided: unknown }[]; checks: { id: number; status: string }[]; balance: { receivedCents: number; outstandingCents: number | null; agreedCents: number | null }
}

/** An order at production_complete with an accepted quote of $20.00 (2 tees at $10), over the API. */
async function completeOrder(page: Page, title: string, extra: object = {}) {
  for (const j of (await production(page)).current) {
    const res = await page.request.patch(`/api/app/orders/${j.number}/production`, { data: { to: 'quality_control', expectedVersion: j.version } })
    expect(res.ok(), await res.text()).toBe(true)
  }
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
  await step('patch', '/production', { to: 'in_production' })
  await step('patch', '/production', { to: 'quality_control' })
  await step('patch', '/production', { to: 'production_complete' })
  return o.number
}

async function payViaApi(page: Page, n: string, amountCents: number) {
  const res = await page.request.post(`/api/app/orders/${n}/payments`, {
    data: { amountCents, method: 'cash', requestId: crypto.randomUUID(), expectedVersion: (await orderState(page, n)).version },
  })
  expect(res.ok(), await res.text()).toBe(true)
}

/** A check collection on a pay-after-pickup order, over the API; moved to ready_for_collection when asked. */
async function checkViaApi(page: Page, n: string, expectedCents: number, ready: boolean) {
  const res = await page.request.post(`/api/app/orders/${n}/checks`, { data: { expectedCents, expectedVersion: (await orderState(page, n)).version } })
  expect(res.ok(), await res.text()).toBe(true)
  const id = (await res.json()).check.id as number
  if (ready) expect((await page.request.post(`/api/app/checks/${id}/ready`, { data: {} })).ok()).toBe(true)
  return id
}

const open = async (page: Page, n: string, tab: string) => {
  await page.goto(`/app/orders/${n}`)
  await page.getByRole('tab', { name: tab, exact: true }).click()
}
const btn = (page: Page, action: string, n: string) => page.getByRole('button', { name: `${action}: ${n}`, exact: true })
const submit = (page: Page, name: string) => dialog(page).getByRole('button', { name, exact: true })

test('notify then pick up a paid order: the order closes', async ({ page }, info) => {
  desktopOnly(info)
  const n = await completeOrder(page, 'Paid pickup')
  await payViaApi(page, n, 2000)
  await open(page, n, 'Pickup')
  await expect(page.getByText('Ready for pickup', { exact: true }).first()).toBeVisible()
  await btn(page, 'Record notification', n).click()
  await submit(page, 'Record notification').click()
  await expect(page.getByText('Customer notified by phone on')).toBeVisible()
  await btn(page, 'Update notification', n).click()
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await btn(page, 'Record pickup', n).click()
  await dialog(page).getByLabel('Collected by').fill('Pat Parent')
  await submit(page, 'Record pickup').click()
  await expect(page.getByText(/Picked up by Pat Parent on/)).toBeVisible()
  await expect(page.getByText('A recorded pickup is final')).toBeVisible()
  await expect.poll(async () => (await orderState(page, n)).state).toBe('closed')
})

test('an unpaid pay-at-pickup order: warning, owner override with a reason', async ({ page }, info) => {
  desktopOnly(info)
  const n = await completeOrder(page, 'Unpaid pickup', { paymentTerms: 'due_at_pickup' })
  await open(page, n, 'Pickup')
  await btn(page, 'Record pickup', n).click()
  await dialog(page).getByLabel('Collected by').fill('Sam Buyer')
  await expect(dialog(page).getByRole('alert').filter({ hasText: 'still owes $20.00' })).toBeVisible()
  await expect(submit(page, 'Record pickup')).toBeDisabled()
  await dialog(page).getByRole('button', { name: 'Release anyway (override)' }).click()
  await expect(submit(page, 'Record pickup')).toBeDisabled()
  await dialog(page).getByLabel('Reason for releasing it unpaid').fill('Customer pays by mail on Friday')
  await submit(page, 'Record pickup').click()
  await expect(page.getByText(/Picked up by Sam Buyer/)).toBeVisible()
  await expect(page.getByText(/Released before payment by .*Customer pays by mail on Friday/)).toBeVisible()
  // Picked up but unpaid: still active.
  expect((await orderState(page, n)).state).toBe('active')
})

test('staff see the unpaid warning and no override', async ({ page }, info) => {
  desktopOnly(info)
  const n = await completeOrder(page, 'Staff pickup', { paymentTerms: 'due_at_pickup' })
  await page.route('**/api/app/me', (r) => r.fulfill({ json: { id: 2, email: 'staff@example.com', name: 'Staff', role: 'staff' } }))
  await open(page, n, 'Pickup')
  await btn(page, 'Record pickup', n).click()
  await dialog(page).getByLabel('Collected by').fill('Sam Buyer')
  await expect(dialog(page).getByRole('alert').filter({ hasText: 'Only an owner can release an unpaid order' })).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: /override/i })).toHaveCount(0)
  await expect(submit(page, 'Record pickup')).toBeDisabled()
})

test('a district order is picked up unpaid, then its check goes ready, collected, deposited, cleared', async ({ page }, info) => {
  desktopOnly(info)
  const n = await completeOrder(page, 'District check', { paymentTerms: 'due_after_pickup' })
  await open(page, n, 'Pickup')
  await btn(page, 'Record pickup', n).click()
  await dialog(page).getByLabel('Collected by').fill('Coach Lee')
  await expect(dialog(page).getByRole('alert').filter({ hasText: 'still owes' })).toHaveCount(0)
  await submit(page, 'Record pickup').click()
  await expect(page.getByText(/Picked up by Coach Lee/)).toBeVisible()

  await page.getByRole('tab', { name: 'Payments', exact: true }).click()
  await page.getByRole('button', { name: 'New check collection', exact: true }).click()
  await submit(page, 'New check collection').click()
  const row = page.getByRole('list', { name: 'Checks' }).getByRole('listitem')
  await expect(row.getByText('Awaiting payment')).toBeVisible()
  await row.getByRole('button', { name: /^Mark ready:/ }).click()
  await expect(row.getByText('Ready for collection')).toBeVisible()

  // A different amount from the expected one is allowed; both are shown.
  await row.getByRole('button', { name: /^Record collection:/ }).click()
  await dialog(page).getByLabel('Amount received').fill('15.00')
  await expect(dialog(page).getByText(/different from the \$20\.00 you expected/)).toBeVisible()
  await dialog(page).getByLabel('Check number (optional)').fill('4411')
  await submit(page, 'Record collection').click()
  await expect(row.getByText('Received $15.00, but $20.00 was expected')).toBeVisible()
  let p = await paymentsOf(page, n)
  expect(p.payments).toHaveLength(1)
  expect(p.balance).toMatchObject({ receivedCents: 1500, outstandingCents: 500 })
  await expect(page.getByRole('list', { name: 'Payments received' }).getByRole('listitem')).toHaveCount(1)

  await row.getByRole('button', { name: /^Mark deposited:/ }).click()
  await expect(row.getByText('Deposited', { exact: true }).first()).toBeVisible()
  await row.getByRole('button', { name: /^Mark cleared:/ }).click()
  await expect(row.getByText('Cleared', { exact: true }).first()).toBeVisible()
  p = await paymentsOf(page, n)
  expect(p.payments).toHaveLength(1)
  expect(p.balance).toMatchObject({ receivedCents: 1500, outstandingCents: 500 })
  expect(p.checks[0].status).toBe('cleared')
})

test('double-clicking Save records exactly one payment', async ({ page }, info) => {
  desktopOnly(info)
  const n = await completeOrder(page, 'Double click')
  await open(page, n, 'Payments')
  await page.getByRole('button', { name: 'Record payment', exact: true }).click()
  await dialog(page).getByLabel('Amount').fill('5.00')
  await submit(page, 'Record payment').dblclick()
  await expect(dialog(page)).toHaveCount(0)
  await page.waitForTimeout(500)
  const p = await paymentsOf(page, n)
  expect(p.payments).toHaveLength(1)
  expect(p.balance.receivedCents).toBe(500)
})

test('an owner voids a payment with a reason: the row stays, struck through, and the balance is restored', async ({ page }, info) => {
  desktopOnly(info)
  const n = await completeOrder(page, 'Void')
  await payViaApi(page, n, 500)
  await open(page, n, 'Payments')
  await page.getByRole('button', { name: 'Void: $5.00' }).click()
  await expect(submit(page, 'Void payment')).toBeDisabled()
  await dialog(page).getByLabel('Reason').fill('Entered on the wrong order')
  await submit(page, 'Void payment').click()
  const row = page.locator('[data-voided="true"]')
  await expect(row).toContainText('Entered on the wrong order')
  await expect(row).toContainText('Voided')
  await expect(row.getByRole('button', { name: /^Void:/ })).toHaveCount(0)
  const p = await paymentsOf(page, n)
  expect(p.payments).toHaveLength(1)
  expect(p.balance).toMatchObject({ receivedCents: 0, outstandingCents: 2000 })
})

test('staff are not offered Void', async ({ page }, info) => {
  desktopOnly(info)
  const n = await completeOrder(page, 'Staff void')
  await payViaApi(page, n, 500)
  await page.route('**/api/app/me', (r) => r.fulfill({ json: { id: 2, email: 'staff@example.com', name: 'Staff', role: 'staff' } }))
  await open(page, n, 'Payments')
  await expect(page.getByText('$5.00').first()).toBeVisible()
  await expect(page.getByRole('button', { name: /^Void:/ })).toHaveCount(0)
})

test('a stale payment dialog shows the conflict notice with fresh values, and the retry works', async ({ page }, info) => {
  desktopOnly(info)
  const n = await completeOrder(page, 'Conflict')
  await open(page, n, 'Payments')
  await page.getByRole('button', { name: 'Record payment', exact: true }).click()
  await expect(dialog(page).getByLabel('Amount')).toHaveValue('20.00')
  await dialog(page).getByLabel('Amount').fill('3.00')
  // Another page records a payment while this dialog is open.
  const other = await page.context().newPage()
  await payViaApi(other, n, 500)
  await other.close()
  await submit(page, 'Record payment').click()
  await expect(dialog(page).getByRole('status').filter({ hasText: 'Someone else changed this' })).toBeVisible()
  await expect(dialog(page).getByLabel('Amount')).toHaveValue('15.00')
  await expect(submit(page, 'Record payment')).toBeEnabled()
  await submit(page, 'Record payment').click()
  await expect(dialog(page)).toHaveCount(0)
  expect((await paymentsOf(page, n)).payments).toHaveLength(2)
})

test('the Payments page lists the outstanding order and the check to collect, with quick actions', async ({ page }, info) => {
  desktopOnly(info)
  const regular = await completeOrder(page, 'Page regular', { paymentTerms: 'due_at_pickup' })
  const district = await completeOrder(page, 'Page district', { paymentTerms: 'due_after_pickup' })
  const checkId = await checkViaApi(page, district, 2000, true)
  await page.goto('/app/payments')
  const outstanding = page.getByRole('region', { name: 'Outstanding', exact: true })
  await expect(outstanding.locator(`[data-order="${regular}"]`)).toContainText('$20.00')
  await expect(outstanding.locator(`[data-order="${district}"]`)).toBeVisible()
  const toCollect = page.getByRole('region', { name: 'Checks to collect' })
  await expect(toCollect.locator(`[data-check="${checkId}"]`)).toContainText(district)

  // Quick action: record the check collection from here.
  await toCollect.locator(`[data-check="${checkId}"]`).getByRole('button', { name: /^Record collection:/ }).click()
  await submit(page, 'Record collection').click()
  await expect(toCollect.locator(`[data-check="${checkId}"]`)).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Checks in hand' }).locator(`[data-check="${checkId}"]`)).toBeVisible()

  // Quick action: record the payment for the pay-at-pickup order; it leaves the list once paid.
  await btn(page, 'Record payment', regular).click()
  await submit(page, 'Record payment').click()
  await expect(outstanding.locator(`[data-order="${regular}"]`)).toHaveCount(0)
})

test('the dashboard: Ready for pickup quick action, outstanding summary, no duplicate-key warning for two checks on one order', async ({ page }, info) => {
  desktopOnly(info)
  const warnings: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') warnings.push(msg.text()) })
  const paid = await completeOrder(page, 'Dash pickup')
  await payViaApi(page, paid, 2000)
  const district = await completeOrder(page, 'Dash checks', { paymentTerms: 'due_after_pickup' })
  await checkViaApi(page, district, 1000, true)
  await checkViaApi(page, district, 1000, true)
  await page.goto('/app')
  const ready = page.getByRole('region', { name: 'Ready for pickup', exact: true })
  await expect(ready.locator(`[data-ready="${paid}"]`)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Outstanding payments' })).toBeVisible()
  const groups = page.getByRole('group', { name: 'Checks to collect' })
  await expect(groups.getByRole('button', { name: new RegExp(`^Record collection: ${district},`) })).toHaveCount(2)

  await btn(page, 'Record notification', paid).click()
  await submit(page, 'Record notification').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(ready.locator(`[data-ready="${paid}"]`)).toContainText('Customer notified')
  await btn(page, 'Record pickup', paid).click()
  await dialog(page).getByLabel('Collected by').fill('Dash Pickup')
  await submit(page, 'Record pickup').click()
  await expect(ready.locator(`[data-ready="${paid}"]`)).toHaveCount(0)
  await expect.poll(async () => (await orderState(page, paid)).state).toBe('closed')
  expect(warnings.filter((w) => /same key|unique "key"/i.test(w))).toEqual([])
})

test('phone: the Payments tab, the Payments page and the dashboard fit 390px and the dialog buttons are reachable', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone')
  const district = await completeOrder(page, 'Camisetas del equipo de fútbol del distrito escolar independiente de Cedar Hollow temporada de primavera', { paymentTerms: 'due_after_pickup' })
  await checkViaApi(page, district, 2000, true)
  const regular = await completeOrder(page, 'Phone regular', { paymentTerms: 'due_at_pickup' })
  await payViaApi(page, regular, 500)
  for (const lang of ['en', 'es'] as const) {
    await page.goto('/app')
    await setLang(page, lang)
    await page.reload()
    await expect(page.getByRole('region', { name: lang === 'en' ? 'Ready for pickup' : 'Listos para entrega', exact: true })).toBeVisible()
    await fits(page)
    await page.goto('/app/payments')
    await expect(page.getByRole('heading', { name: lang === 'en' ? 'Checks to collect' : 'Cheques por cobrar' })).toBeVisible()
    await fits(page)
    await open(page, regular, lang === 'en' ? 'Payments' : 'Pagos')
    await expect(page.getByRole('list', { name: lang === 'en' ? 'Payments received' : 'Pagos recibidos' })).toBeVisible()
    await fits(page)
    await page.getByRole('button', { name: lang === 'en' ? 'Record payment' : 'Registrar pago', exact: true }).click()
    await expect(dialog(page).getByRole('button', { name: lang === 'en' ? 'Cancel' : 'Cancelar' })).toBeInViewport()
    await expect(submit(page, lang === 'en' ? 'Record payment' : 'Registrar pago')).toBeInViewport()
    await fits(page)
    await page.keyboard.press('Escape')
    await open(page, district, lang === 'en' ? 'Payments' : 'Pagos')
    await fits(page)
    await open(page, regular, lang === 'en' ? 'Pickup' : 'Entrega')
    await btn(page, lang === 'en' ? 'Record pickup' : 'Registrar entrega', regular).click()
    await expect(dialog(page).getByRole('alert').first()).toBeVisible()
    await expect(submit(page, lang === 'en' ? 'Record pickup' : 'Registrar entrega')).toBeInViewport()
    await fits(page)
  }
})

test('Spanish: the Pickup and Payments tabs and the pickup dialog', async ({ page }, info) => {
  desktopOnly(info)
  const n = await completeOrder(page, 'Spanish pickup', { paymentTerms: 'due_at_pickup' })
  await page.goto('/app')
  await setLang(page, 'es')
  await open(page, n, 'Entrega')
  await expect(page.getByText('Listo para entrega desde el')).toBeVisible()
  await btn(page, 'Registrar entrega', n).click()
  await expect(dialog(page).getByRole('heading', { name: 'Registrar entrega' })).toBeVisible()
  await expect(dialog(page).getByText(/aún debe \$20\.00/)).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: 'Entregar de todos modos (excepción)' })).toBeVisible()
  await dialog(page).getByRole('button', { name: 'Cancelar' }).click()
  await page.getByRole('tab', { name: 'Pagos', exact: true }).click()
  await expect(page.getByText('Total acordado')).toBeVisible()
  await page.getByRole('button', { name: 'Registrar pago', exact: true }).click()
  await expect(dialog(page).getByLabel('Monto')).toBeVisible()
  await expect(dialog(page).getByLabel('Método')).toBeVisible()
})
