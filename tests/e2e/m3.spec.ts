import { expect, test, type Page } from '@playwright/test'
import { makeOrder } from './helpers.ts'
import { reseed } from './prepare.ts'

// M3: purchases, deliveries, cancelling, and preparation, through the real UI. Orders are made over the API so nothing depends on the seed.
test.afterAll(() => {
  reseed()
})

const dialog = (page: Page) => page.getByRole('dialog')
const row = (page: Page, key: string) => page.locator(`[data-readiness="${key}"]`)
const fits = async (page: Page) => {
  const scroll = (await page.evaluate('document.documentElement.scrollWidth')) as number
  const width = (await page.evaluate('window.innerWidth')) as number
  expect(scroll).toBeLessThanOrEqual(width)
}

/** Accept the quote, authorize, and mark artwork not required, over the API, so materials is the only open item before prep. */
async function ready(page: Page, title: string) {
  const o = await makeOrder(page, title)
  let version = o.version
  const step = async (method: 'post' | 'patch', path: string, data: object) => {
    const res = await page.request[method](`/api/app/orders/${o.number}${path}`, { data: { ...data, expectedVersion: version } })
    expect(res.ok(), await res.text()).toBe(true)
    version = (await res.json()).version
  }
  await step('post', '/quotes', {})
  await step('patch', '/quotes/1', { to: 'accepted' })
  await step('post', '/authorization', { method: 'phone' })
  await step('patch', '', { artworkRequired: false })
  return o
}

const openPurchasingAny = async (page: Page, number: string) => {
  await page.goto(`/app/orders/${number}`)
  await page.getByRole('tab').filter({ hasText: /^(Purchasing|Compras)$/ }).click()
}
const openPurchasing = async (page: Page, number: string) => {
  await page.goto(`/app/orders/${number}`)
  await page.getByRole('tab', { name: 'Purchasing' }).click()
}

async function addPurchase(page: Page, description: string, quantity: string) {
  await page.getByRole('button', { name: 'Add purchase', exact: true }).first().click()
  await dialog(page).getByLabel('Description').fill(description)
  await dialog(page).getByLabel('Quantity').fill(quantity)
  await dialog(page).getByLabel('Estimated unit cost (USD)').fill('6.50')
  await dialog(page).getByRole('button', { name: 'Add purchase', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
}

test('purchase: add with the default supplier, order, partial then full delivery, checklist and production advance', async ({ page }) => {
  const o = await ready(page, 'Purchase flow')
  await page.goto(`/app/orders/${o.number}`)
  await expect(row(page, 'materials')).toContainText('Pending')
  await expect(page.getByRole('group', { name: 'Production' }).first()).toContainText('Awaiting materials')

  // The checklist action opens the add dialog on the Purchasing tab, with the default supplier chosen.
  await row(page, 'materials').getByRole('button', { name: 'Add purchase' }).click()
  await expect(dialog(page).getByLabel('Supplier').locator('option:checked')).toHaveText('JDS (default)')
  await dialog(page).getByLabel('Description').fill('Heavy cotton tee, Navy')
  await dialog(page).getByLabel('Quantity').fill('5')
  await dialog(page).getByLabel('Estimated unit cost (USD)').fill('6.50')
  await dialog(page).getByRole('button', { name: 'Add purchase', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)

  const p = page.getByRole('region', { name: 'Heavy cotton tee, Navy' })
  await expect(p).toContainText('Not ordered')
  await expect(p).toContainText('JDS')
  await expect(p).toContainText('Estimated $32.50')
  await expect(page.getByText('Purchasing usually starts after authorization.')).toHaveCount(0)

  await p.getByRole('button', { name: 'Mark ordered' }).click()
  await expect(dialog(page).getByLabel('Ordered on')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/)
  await dialog(page).getByRole('button', { name: 'Mark ordered' }).click()
  await expect(p).toContainText('Ordered')
  await expect(p.getByRole('button', { name: 'Mark ordered' })).toHaveCount(0)

  // Partial delivery: the purchase is partially received and the checklist stays pending.
  await p.getByRole('button', { name: 'Record delivery' }).click()
  await dialog(page).getByLabel('Quantity').fill('2')
  await dialog(page).getByRole('button', { name: 'Record delivery' }).click()
  await expect(p).toContainText('Partially received')
  await expect(p).toContainText('2 of 5 received')
  await expect(row(page, 'materials')).toContainText('Pending')

  await p.getByRole('button', { name: 'Record delivery' }).click()
  await expect(dialog(page).getByLabel('Quantity')).toHaveValue('3')
  await dialog(page).getByRole('button', { name: 'Record delivery' }).click()
  await expect(p.getByRole('list', { name: 'Deliveries' }).getByRole('listitem')).toHaveCount(2)
  await expect(row(page, 'materials')).toContainText('Complete')
  await expect(page.getByRole('group', { name: 'Production' }).first()).toContainText('Awaiting preparation')

  // Actual cost is still editable once everything is in; description is locked.
  await p.getByRole('button', { name: 'Edit' }).click()
  await expect(dialog(page).getByLabel('Description')).toHaveAttribute('readonly', '')
  await dialog(page).getByLabel('Actual unit cost (USD)').fill('6.00')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(p).toContainText('actual $30.00')
})

test('cancel a purchase needs a reason', async ({ page }) => {
  const o = await makeOrder(page, 'Cancel purchase')
  await openPurchasing(page, o.number)
  await expect(page.getByText('Purchasing usually starts after authorization.')).toBeVisible()
  await addPurchase(page, 'Hoodies', '4')
  const p = page.getByRole('region', { name: 'Hoodies' })
  await p.getByRole('button', { name: 'Cancel purchase' }).click()
  await expect(dialog(page).getByRole('button', { name: 'Cancel purchase' })).toBeDisabled()
  await dialog(page).getByLabel('Reason').fill('Customer changed the order')
  await dialog(page).getByRole('button', { name: 'Cancel purchase' }).click()
  await expect(p).toContainText('Cancelled')
  await expect(p.getByRole('button')).toHaveCount(0)
})

test('no purchasing needed is stated in the tab', async ({ page }) => {
  const o = await makeOrder(page, 'No purchasing')
  await page.goto(`/app/orders/${o.number}`)
  await row(page, 'materials').getByRole('button', { name: 'Confirm no purchasing needed' }).click()
  await dialog(page).getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(row(page, 'materials')).toContainText('Not required')
  await page.getByRole('tab', { name: 'Purchasing' }).click()
  await expect(page.getByText('This order is marked "No purchasing needed".')).toBeVisible()
})

test('preparation: start from the checklist, set Ready from the Production tab', async ({ page }) => {
  const o = await ready(page, 'Prep flow')
  await page.goto(`/app/orders/${o.number}`)
  await row(page, 'materials').getByRole('button', { name: 'Confirm no purchasing needed' }).click()
  await dialog(page).getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(row(page, 'preparation')).toContainText('Pending')
  await row(page, 'preparation').getByRole('button', { name: 'Start preparation' }).click()
  await page.getByRole('tab', { name: 'Production' }).click()
  await expect(page.getByRole('button', { name: 'In progress', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Ready', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Ready', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(row(page, 'preparation')).toContainText('Complete')
  await expect(page.getByRole('group', { name: 'Production' }).first()).toContainText('Ready for production')
})

const refetch = (page: Page) => page.evaluate("window.dispatchEvent(new Event('visibilitychange'))")
const base = 'http://localhost:4280'

type W = { number: string; version: number }
/** One write over the API as whoever `page` is; returns the order's new version and the new row's id (creates). */
async function write(page: Page, o: W, method: 'post' | 'patch', path: string, data: object) {
  const res = await page.request[method](`/api/app/orders/${o.number}${path}`, { data: { ...data, expectedVersion: o.version } })
  expect(res.ok(), await res.text()).toBe(true)
  const j = await res.json()
  o.version = j.version
  return j.id as number
}
const purchasesOf = async (page: Page, number: string) => (await (await page.request.get(`/api/app/orders/${number}/purchases`)).json()).purchases as {
  id: number; description: string; quantity: number; sizes: Record<string, number> | null; notes: string | null; actualUnitCostCents: number | null
  status: string; receivedQuantity: number; receipts: { quantity: number; sizes: Record<string, number> | null }[]
}[]
/** An ordered purchase made over the API. */
async function ordered(page: Page, o: W, description: string, quantity: number) {
  const id = await write(page, o, 'post', '/purchases', { description, quantity, estimatedUnitCostCents: 650 })
  await write(page, o, 'post', `/purchases/${id}/ordered`, {})
  return id
}

test('a purchase edit open behind another browser\'s save: its typing survives a refetch, the conflict loads fresh values, the second save wins cleanly', async ({ browser, page }, info) => {
  test.skip(info.project.name !== 'desktop')
  const o = await makeOrder(page, 'Purchase conflict')
  const w: W = { number: o.number, version: o.version }
  const id = await write(page, w, 'post', '/purchases', { description: 'Conflict tees', quantity: 4, estimatedUnitCostCents: 650, notes: 'original' })
  const b = await (await browser.newContext({ baseURL: base })).newPage()
  await openPurchasing(page, o.number)
  await openPurchasing(b, o.number)

  const card = (pg: Page) => pg.locator(`[data-purchase="${id}"]`) // a modal hides the region role
  await card(page).getByRole('button', { name: 'Edit' }).click()
  await dialog(page).getByLabel('Notes').fill('A first try')

  await card(b).getByRole('button', { name: 'Edit' }).click()
  await dialog(b).getByLabel('Notes').fill('From B')
  await dialog(b).getByLabel('Estimated unit cost (USD)').fill('7.00')
  await dialog(b).getByRole('button', { name: 'Save' }).click()
  await expect(card(b)).toContainText('From B')

  await refetch(page)
  await expect(card(page)).toContainText('From B') // the list behind the dialog moved on
  await expect(dialog(page).getByLabel('Notes')).toHaveValue('A first try') // the open form did not

  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page).getByRole('status')).toContainText('Someone else changed this')
  await expect(dialog(page).getByLabel('Notes')).toHaveValue('From B') // B's values, not the snapshot from when A opened it
  await expect(dialog(page).getByLabel('Estimated unit cost (USD)')).toHaveValue('7.00')
  await expect(dialog(page).getByRole('button', { name: 'Save' })).toBeEnabled()

  await dialog(page).getByLabel('Notes').fill('A second, after reload')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page)).toHaveCount(0)
  const mine = (await purchasesOf(page, o.number)).find((x) => x.id === id)!
  expect(mine.notes).toBe('A second, after reload')
  expect(mine.notes).not.toContain('first try')
  expect((await (await page.request.get(`/api/app/orders/${o.number}/purchases`)).json()).purchases[0].estimatedUnitCostCents).toBe(700) // B's cost was not overwritten
  await b.context().close()
})

test('conflict recovery waits for a SUCCESSFUL purchases refresh: a failed one keeps Save blocked (Codex review of 9fc0d62)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  const o = await makeOrder(page, 'Failed refresh')
  const w: W = { number: o.number, version: o.version }
  const id = await write(page, w, 'post', '/purchases', { description: 'Refresh tees', quantity: 4, notes: 'original' })
  await openPurchasing(page, o.number)
  const card = page.locator(`[data-purchase="${id}"]`)
  await card.getByRole('button', { name: 'Edit' }).click()
  await dialog(page).getByLabel('Notes').fill('A stale try')
  await write(page, w, 'patch', `/purchases/${id}`, { notes: 'From elsewhere' }) // someone else saves; the page doesn't know
  await page.route(`**/api/app/orders/${o.number}/purchases`, (r) => r.fulfill({ status: 500, body: '{}' }))
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page).getByRole('status')).toContainText('Someone else changed this')
  await page.waitForTimeout(1500) // the order refetch lands; the purchases one fails (and retries fail)
  await expect(dialog(page).getByRole('button', { name: 'Save' })).toBeDisabled() // stale purchase values must not pair with the new version
  await page.unroute(`**/api/app/orders/${o.number}/purchases`)
  await refetch(page)
  await expect(dialog(page).getByLabel('Notes')).toHaveValue('From elsewhere')
  await expect(dialog(page).getByRole('button', { name: 'Save' })).toBeEnabled()
})

test('a receipt dialog behind another browser\'s delivery reloads the remaining quantity, and a cancelled purchase disables Save', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  const o = await makeOrder(page, 'Receipt conflict')
  const w: W = { number: o.number, version: o.version }
  const id = await ordered(page, w, 'Receipt conflict tees', 10)
  await openPurchasing(page, o.number)
  const card = page.locator(`[data-purchase="${id}"]`)
  await card.getByRole('button', { name: 'Record delivery' }).click()
  await expect(dialog(page).getByLabel('Quantity')).toHaveValue('10')
  await dialog(page).getByLabel('Quantity').fill('3')

  // Someone else records 6 of the 10.
  await write(page, w, 'post', `/purchases/${id}/receipts`, { quantity: 6 })
  await refetch(page)
  await expect(card).toContainText('6 of 10 received')
  await expect(dialog(page).getByLabel('Quantity')).toHaveValue('3')
  await dialog(page).getByRole('button', { name: 'Record delivery' }).click()
  await expect(dialog(page).getByRole('status')).toContainText('Someone else changed this')
  await expect(dialog(page).getByLabel('Quantity')).toHaveValue('4') // the fresh remaining, not 10
  await dialog(page).getByRole('button', { name: 'Record delivery' }).click()
  await expect(dialog(page)).toHaveCount(0)
  const stored = (await purchasesOf(page, o.number)).find((x) => x.id === id)!
  expect(stored.receipts.map((r) => r.quantity).sort()).toEqual([4, 6])

  // The purchase is cancelled behind an open edit: once the list refetches the dialog says so and Save is disabled.
  const w2: W = { number: o.number, version: (await (await page.request.get(`/api/app/orders/${o.number}`)).json()).order.version }
  const id2 = await write(page, w2, 'post', '/purchases', { description: 'Doomed tees', quantity: 2 })
  await refetch(page)
  const doomed = page.getByRole('region', { name: 'Doomed tees' })
  await doomed.getByRole('button', { name: 'Edit' }).click()
  await dialog(page).getByLabel('Notes').fill('typing')
  await write(page, w2, 'post', `/purchases/${id2}/cancel`, { reason: 'Mistake' })
  await refetch(page)
  await expect(dialog(page).getByRole('alert')).toContainText('cancelled or changed')
  await expect(dialog(page).getByRole('button', { name: 'Save' })).toBeDisabled()
})

test('a fully received purchase still offers Record delivery and Cancel; a late extra delivery shows the over-received note', async ({ page }) => {
  const o = await makeOrder(page, 'Late delivery')
  const w: W = { number: o.number, version: o.version }
  const id = await ordered(page, w, 'Late tees', 5)
  await write(page, w, 'post', `/purchases/${id}/receipts`, { quantity: 5 })
  await openPurchasing(page, o.number)
  const card = page.getByRole('region', { name: 'Late tees' })
  await expect(card).toContainText('Received')
  await expect(card.getByRole('button', { name: 'Cancel purchase' })).toBeVisible()
  await expect(card).not.toContainText('more than ordered')
  await card.getByRole('button', { name: 'Record delivery' }).click()
  await dialog(page).getByLabel('Quantity').fill('2')
  await dialog(page).getByRole('button', { name: 'Record delivery' }).click()
  await expect(card).toContainText('7 of 5 received')
  await expect(card.getByRole('status')).toContainText('2 more than ordered')
})

test('the Add purchase dialog returns focus to its opener after Escape and after a Save', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  const o = await makeOrder(page, 'Purchase focus')
  await openPurchasing(page, o.number)
  const add = page.getByRole('button', { name: 'Add purchase', exact: true }).first()
  await add.focus()
  await page.keyboard.press('Enter')
  await expect(dialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(add).toBeFocused()
  await page.keyboard.press('Enter')
  await dialog(page).getByLabel('Description').fill('Focus tees')
  await dialog(page).getByLabel('Quantity').fill('2')
  await dialog(page).getByRole('button', { name: 'Add purchase', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Focus tees' })).toBeVisible()
  await expect(add).toBeFocused()
})

test('phone: the dialog\'s Save and Cancel are reachable and nothing scrolls sideways, in English and Spanish', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone-width pass')
  const o = await makeOrder(page, 'Phone dialog')
  for (const lang of ['en', 'es']) {
    await page.goto('/app')
    await page.evaluate((l) => localStorage.setItem('lang', l), lang)
    await openPurchasingAny(page, o.number)
    await page.locator('main').getByRole('button').filter({ hasText: lang === 'en' ? 'Add purchase' : 'Agregar compra' }).first().click()
    const d = dialog(page)
    await d.locator('input[type=checkbox]').check()
    const save = d.locator('button[type=submit]')
    const cancel = d.getByRole('button', { name: lang === 'en' ? 'Cancel' : 'Cancelar', exact: true })
    for (const btn of [cancel, save]) {
      await btn.scrollIntoViewIfNeeded()
      await expect(btn).toBeVisible()
      const box = (await btn.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
      expect(box.y + box.height).toBeLessThanOrEqual(844)
    }
    await fits(page)
    await cancel.click()
    await expect(d).toHaveCount(0)
  }
  await page.evaluate(() => localStorage.setItem('lang', 'en'))
})

test('a purchase with a size breakdown and a receipt with sizes store the quantity and the sizes', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  const o = await makeOrder(page, 'Sizes purchase')
  await openPurchasing(page, o.number)
  await page.getByRole('button', { name: 'Add purchase', exact: true }).first().click()
  await dialog(page).getByLabel('Description').fill('Sized tees')
  await dialog(page).getByLabel('Use size breakdown').check()
  await dialog(page).getByLabel('Size M', { exact: true }).fill('3')
  await dialog(page).getByLabel('Size L', { exact: true }).fill('4')
  await expect(dialog(page).getByLabel('Quantity')).toHaveValue('7')
  await dialog(page).getByRole('button', { name: 'Add purchase', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  let stored = (await purchasesOf(page, o.number)).find((x) => x.description === 'Sized tees')!
  expect(stored.quantity).toBe(7)
  expect(stored.sizes).toEqual({ M: 3, L: 4 })

  const w: W = { number: o.number, version: (await (await page.request.get(`/api/app/orders/${o.number}`)).json()).order.version }
  await write(page, w, 'post', `/purchases/${stored.id}/ordered`, {})
  await page.reload()
  await page.getByRole('tab', { name: 'Purchasing' }).click()
  await page.getByRole('region', { name: 'Sized tees' }).getByRole('button', { name: 'Record delivery' }).click()
  await dialog(page).getByLabel('Use size breakdown').check()
  await dialog(page).getByLabel('Size M', { exact: true }).fill('2')
  await dialog(page).getByLabel('Size L', { exact: true }).fill('1')
  await dialog(page).getByRole('button', { name: 'Record delivery' }).click()
  await expect(dialog(page)).toHaveCount(0)
  stored = (await purchasesOf(page, o.number)).find((x) => x.id === stored.id)!
  expect(stored.receivedQuantity).toBe(3)
  expect(stored.receipts[0]).toMatchObject({ quantity: 3, sizes: { M: 2, L: 1 } })
})

test('phone: the Purchasing tab fits the width', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone-width pass')
  const o = await ready(page, 'Phone purchasing')
  await openPurchasing(page, o.number)
  await addPurchase(page, 'A very long purchase description for a heavy cotton school spirit tee in navy blue', '12')
  const p = page.getByRole('region').filter({ hasText: 'A very long purchase description' })
  await p.getByRole('button', { name: 'Mark ordered' }).click()
  await dialog(page).getByRole('button', { name: 'Mark ordered' }).click()
  await p.getByRole('button', { name: 'Record delivery' }).click()
  await dialog(page).getByLabel('Quantity').fill('5')
  await dialog(page).getByRole('button', { name: 'Record delivery' }).click()
  await expect(p).toContainText('Partially received')
  await fits(page)
  await page.getByRole('button', { name: 'Add purchase', exact: true }).first().click()
  await dialog(page).getByLabel('Use size breakdown').check()
  await fits(page)
  const box = await dialog(page).boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
})
