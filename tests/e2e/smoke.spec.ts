import { expect, test } from '@playwright/test'

test('storefront, dashboard and API answer', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Storefront' })).toBeVisible()
  await page.goto('/app')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  expect(await (await request.get('/api/health')).json()).toEqual({ ok: true })
})
