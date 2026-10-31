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

test('a stale version on a purchase dialog shows the conflict notice', async ({ page }) => {
  const o = await makeOrder(page, 'Stale purchase')
  await openPurchasing(page, o.number)
  await page.getByRole('button', { name: 'Add purchase', exact: true }).first().click()
  await dialog(page).getByLabel('Description').fill('Stale tees')
  await dialog(page).getByLabel('Quantity').fill('3')
  // Another session changes the order while the dialog is open.
  const res = await page.request.patch(`/api/app/orders/${o.number}`, { data: { title: 'Changed elsewhere', expectedVersion: o.version } })
  expect(res.ok(), await res.text()).toBe(true)
  await dialog(page).getByRole('button', { name: 'Add purchase', exact: true }).click()
  await expect(dialog(page).getByRole('status')).toContainText('Someone else changed this')
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
