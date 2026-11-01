import { expect, test } from '@playwright/test'

test('storefront renders and the API answers', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await (await request.get('/api/health')).json()).toEqual({ ok: true })
})
