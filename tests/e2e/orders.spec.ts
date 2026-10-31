import { expect, test } from '@playwright/test'
import { reseed } from './prepare.ts'

// Seed facts used here (scripts/seed.sql): order 2026-0011 requires a PO, has approved artwork and a
// PO in 'received', so approving the PO is exactly what opens its production gate.
const GATED = '2026-0011'

test.afterAll(() => {
  reseed() // the approval test below writes to the local D1
})

test('dashboard shows the metric strip with numbers', async ({ page }) => {
  await page.goto('/app')
  const strip = page.getByRole('region', { name: 'Overview' })
  await expect(strip).toBeVisible()
  const values = strip.locator('[data-kpi]')
  await expect(values).toHaveCount(7)
  for (const v of await values.allTextContents()) expect(v).toMatch(/^\d+$/)
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Due this week' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible()
})

test('needs-attention rows link to the order detail', async ({ page }) => {
  await page.goto('/app')
  const table = page.getByRole('region', { name: 'Needs attention' })
  const first = table.getByRole('link', { name: /^\d{4}-\d{4}$/ }).first()
  const number = await first.textContent()
  await first.click()
  await expect(page).toHaveURL(new RegExp(`/app/orders/${number}$`))
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(number!)
})

test('orders list switches views and searching narrows the rows', async ({ page }) => {
  await page.goto('/app/orders')
  const rows = page.locator('tbody tr')
  await expect(rows.first()).toBeVisible()
  const all = await rows.count()
  expect(all).toBeGreaterThan(1)

  await page.getByRole('tab', { name: /^Waiting on PO/ }).click()
  await expect(page).toHaveURL(/view=waiting_po/)
  await expect(page.getByRole('tab', { name: /^Waiting on PO/ })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: /^Active/ }).click()
  await expect(page).not.toHaveURL(/view=/)

  await page.getByRole('searchbox', { name: 'Filter orders' }).fill(GATED)
  await expect(page).toHaveURL(new RegExp(`q=${GATED}`))
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText(GATED)

  // view and q survive a reload
  await page.reload()
  await expect(page.getByRole('searchbox', { name: 'Filter orders' })).toHaveValue(GATED)
  await expect(rows).toHaveCount(1)

  // the whole row navigates
  await rows.first().getByRole('cell').nth(5).click()
  await expect(page).toHaveURL(new RegExp(`/app/orders/${GATED}$`))
})

test('desktop: approving the PO from its dropdown opens the production gate', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  await page.goto(`/app/orders/${GATED}`)
  const banner = page.getByRole('status').filter({ hasText: 'Production is locked.' })
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('purchase order')
  await expect(banner.getByRole('button', { name: 'Record approval' })).toHaveCount(0) // PO is only 'received'

  await page.getByRole('button', { name: /^Purchase order: Received/ }).click()
  await page.getByRole('menuitem', { name: 'Under review' }).click()
  await expect(banner.getByRole('button', { name: 'Record approval' })).toBeVisible()

  await page.getByRole('button', { name: /^Purchase order: Under review/ }).click()
  await expect(page.getByRole('menuitem')).toHaveText(['Approved', 'Rejected', 'Correction required'])
  await page.getByRole('menuitem', { name: 'Approved' }).click()

  await expect(banner).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Production: Ready/ })).toBeVisible()
})

test('Spanish toggle translates chip labels', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  await page.goto('/app/orders')
  await page.getByRole('button', { name: 'Español' }).click()
  await expect(page.getByRole('heading', { name: 'Pedidos', exact: true })).toBeVisible()
  await expect(page.getByText('Esperando autorización').first()).toBeVisible()
  await expect(page.getByText('Aprobado', { exact: true }).first()).toBeVisible()
  await page.goto('/app/orders/2026-0010') // still gated whatever the approval test did to GATED
  await expect(page.getByText('La producción está bloqueada.')).toBeVisible()
})

test('unknown order shows a not-found state with a way back', async ({ page }) => {
  await page.goto('/app/orders/2099-9999')
  await expect(page.getByRole('heading', { name: 'Order not found' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to orders' }).click()
  await expect(page).toHaveURL(/\/app\/orders$/)
})

test('phone: no horizontal page overflow on dashboard, orders and detail', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone')
  for (const [path, ready] of [['/app', 'Needs attention'], ['/app/orders', 'Order views'], [`/app/orders/${GATED}`, 'Order sections']] as const) {
    await page.goto(path)
    await expect(page.getByText(ready, { exact: true }).or(page.getByRole('tablist', { name: ready })).first()).toBeVisible()
    const scroll = (await page.evaluate('document.documentElement.scrollWidth')) as number
    const width = (await page.evaluate('window.innerWidth')) as number
    expect(scroll, path).toBeLessThanOrEqual(width)
  }
})
