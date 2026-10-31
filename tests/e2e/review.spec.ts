import { expect, test, type Page } from '@playwright/test'
import { makeOrder } from './helpers.ts'
import { reseed } from './prepare.ts'

// Codex review of the M1 screens: forms keep the version they started from, new-order customer choice,
// dialog focus. Every test makes its own customer and order through the API, so nothing depends on the seed.
test.afterAll(() => {
  reseed()
})

const refetch = (page: Page) => page.evaluate("window.dispatchEvent(new Event('visibilitychange'))")

test('a form open behind another browser\'s save keeps its version, then discards its stale values on the conflict', async ({ browser, page }, info) => {
  test.skip(info.project.name !== 'desktop')
  const { number } = await makeOrder(page, 'Conflict base')
  const b = await (await browser.newContext({ baseURL: 'http://localhost:4280' })).newPage()
  await page.goto(`/app/orders/${number}`)
  await b.goto(`/app/orders/${number}`)

  const details = (p: Page) => p.getByRole('region', { name: 'Details' })
  await details(page).getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Order title').fill('From A')

  await details(b).getByRole('button', { name: 'Edit' }).click()
  await b.getByLabel('Order title').fill('From B')
  await details(b).getByRole('button', { name: 'Save' }).click()
  await expect(b.getByRole('heading', { level: 1 })).toHaveText('From B')

  // A's page refetches in the background and now shows B's title in the header; its open form must not adopt B's version.
  await refetch(page)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('From B')
  await expect(page.getByLabel('Order title')).toHaveValue('From A')

  await details(page).getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Someone else changed this while you were editing' })).toBeVisible()
  await expect(page.getByLabel('Order title')).toHaveValue('From B') // stale values discarded, fresh ones loaded
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('From B') // A's edit was never applied
  const now = await (await page.request.get(`/api/app/orders/${number}`)).json()
  expect(now.order.title).toBe('From B')
  await b.context().close()
})

test('new order: editing the customer text un-chooses the customer and blocks saving', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  const name = `Picker Person ${Date.now()}`
  await page.request.post('/api/app/customers', { data: { name, kind: 'district' } })
  await page.goto('/app/orders/new')
  const box = page.getByRole('combobox', { name: 'Customer' })
  const save = page.getByRole('button', { name: 'Save order' })
  await expect(save).toBeDisabled() // no customer yet
  await box.fill(name)
  await page.getByRole('option', { name }).click()
  await expect(page.getByText('Defaults from this customer:')).toBeVisible()
  await expect(page.getByLabel('PO required')).toBeChecked() // a district's default
  await expect(save).toBeEnabled()

  await box.press('End')
  await box.pressSequentially('x')
  await expect(page.getByText('Defaults from this customer:')).toHaveCount(0)
  await expect(page.getByLabel(/^Contact/)).toBeDisabled()
  await expect(save).toBeDisabled()
  await expect(page.getByRole('button', { name: /Save & create quote/ })).toBeDisabled()

  await box.fill(name) // typing the name back is not a choice: it must come from the results
  await expect(save).toBeDisabled()
  await box.fill(name.slice(0, -2))
  await page.getByRole('option', { name }).click()
  await expect(save).toBeEnabled()
})

test('dialogs give focus back to what opened them: Escape, Cancel, Save, and a removed opener', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  const { number, customerId } = await makeOrder(page, 'Focus order')
  await page.goto(`/app/customers/${customerId}`)
  const edit = page.getByRole('button', { name: 'Edit customer' })
  const open = async () => {
    await edit.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
  }
  await open()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(edit).toBeFocused()
  await open()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(edit).toBeFocused()
  await open()
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(edit).toBeFocused()

  // Recording authorization removes the checklist's own button, so the opener is gone: focus falls back to the page's main area.
  await page.goto(`/app/orders/${number}`)
  const record = page.locator('[data-readiness="authorization"]').getByRole('button', { name: 'Record authorization' })
  await record.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('dialog').getByRole('button', { name: 'Record', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('main')).toBeFocused()
})

test('a quote with no product line cannot be accepted: both Accept buttons are disabled with the reason', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  const { number, version } = await makeOrder(page, 'Charge only', [{ kind: 'charge', description: 'Setup fee', quantity: 1, unitPriceCents: 500 }])
  expect((await page.request.post(`/api/app/orders/${number}/quotes`, { data: { expectedVersion: version } })).ok()).toBe(true)
  await page.goto(`/app/orders/${number}`)
  const row = page.locator('[data-readiness="quote"]')
  await expect(row.getByRole('button', { name: 'Accept quote' })).toBeDisabled()
  await expect(row.getByText('Add a product line before accepting.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeDisabled()
  await expect(page.getByRole('tabpanel').getByText('Add a product line before accepting.')).toBeVisible()
})
