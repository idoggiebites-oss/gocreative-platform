import { expect, test } from '@playwright/test'

const palette = process.platform === 'darwin' ? 'Meta+K' : 'Control+K'

test('desktop: sidebar sections and navigation', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  await page.goto('/app')
  const nav = page.getByRole('navigation', { name: 'Main' })
  for (const n of ['Dashboard', 'Orders', 'Customers', 'Artwork', 'Purchase orders', 'Production']) {
    await expect(nav.getByRole('link', { name: n, exact: true })).toBeVisible()
  }
  await expect(page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Settings' })).toBeVisible()
  await nav.getByRole('link', { name: 'Orders', exact: true }).click()
  await expect(page).toHaveURL(/\/app\/orders$/)
  await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible()
})

test('palette opens on the shortcut, navigates, and opens an order by number', async ({ page }) => {
  await page.goto('/app')
  await expect(page.getByRole('button', { name: 'Search' })).toBeVisible() // shell mounted, listener attached
  await page.keyboard.press(palette)
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('option', { name: 'Orders', exact: true }).click()
  await expect(page).toHaveURL(/\/app\/orders$/)

  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByRole('combobox').fill('2026-0138')
  await page.getByRole('option', { name: 'Open order 2026-0138' }).click()
  await expect(page).toHaveURL(/\/app\/orders\/2026-0138$/)
})

test('desktop: Spanish toggle changes nav, html lang, and survives reload', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  await page.goto('/app')
  await page.getByRole('button', { name: 'Español' }).click()
  await expect(page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Pedidos', exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await page.reload()
  await expect(page.getByRole('link', { name: 'Pedidos', exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
})

test('phone: menu button opens the nav sheet', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone')
  await page.goto('/app')
  await expect(page.getByRole('link', { name: 'Orders', exact: true })).toBeHidden()
  await page.getByRole('button', { name: 'Menu' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('link', { name: 'Orders', exact: true })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Español' })).toBeVisible()
  await sheet.getByRole('link', { name: 'Customers' }).click()
  await expect(page).toHaveURL(/\/app\/customers$/)
  await expect(page.getByRole('dialog')).toBeHidden()
})
