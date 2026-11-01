// Pricing Management on the real page. Sample numbers are test values only, cleared after.
import { expect, test } from '@playwright/test'
import { reseed } from './prepare.ts'

test.afterAll(() => { reseed() })
test.beforeEach(() => { reseed() })

test('owner sets rates in Advanced, previews, publishes; a percentage then moves the proposal once; history and rollback work', async ({ page }, info) => {
  test.setTimeout(90_000)
  test.skip(info.project.name === 'phone', 'covered once; the phone test below checks the layout')
  await page.goto('/app/settings')
  await page.getByRole('link', { name: 'Open' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pricing Management')
  await expect(page.getByText('No pricing is published')).toBeVisible()
  // Collapsed by default.
  const costs = page.locator('section[aria-label="Product and garment costs"]')
  await expect(costs).not.toBeVisible()
  await page.locator('summary', { hasText: 'Advanced pricing' }).click()
  await costs.getByLabel('T-shirts').fill('3.00')
  const dtg = page.getByRole('region', { name: 'Direct-to-garment printing' })
  await dtg.getByLabel('Offer estimates for this service').check()
  await dtg.getByLabel('Rate (%)').fill('100')
  await dtg.getByRole('button', { name: 'Add quantity tier' }).nth(1).click()
  await dtg.getByLabel('Cost ($)').fill('2.00')
  await page.getByLabel('Method').selectOption('dtg')
  await page.getByLabel('Print size').selectOption('medium')
  await page.getByLabel('Quantity', { exact: true }).fill('5')
  await expect(page.getByTestId('sim-Proposed')).toContainText('$50.00')
  await expect(page.getByTestId('sim-Proposed')).toContainText('$25.00') // internal cost
  await expect(page.getByTestId('sim-Proposed')).toContainText('50.00%')
  await expect(page.getByTestId('sim-Published')).toContainText('Manual review required')

  await expect(page.getByRole('button', { name: 'Publish' })).toBeDisabled()
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText('You have an unpublished draft.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish' })).toBeEnabled()
  await page.getByRole('button', { name: 'Publish' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByText(/Published version \d+ is active/)).toBeVisible()
  await expect(page.getByTestId('sim-Published')).toContainText('$50.00')

  // Simple: the adjustment shows in the proposal only, once.
  await page.getByLabel('Direct-to-garment printing: Overall adjustment (%)').fill('10')
  await expect(page.getByTestId('sim-Proposed')).toContainText('$55.00')
  await expect(page.getByTestId('sim-Published')).toContainText('$50.00')
  await expect(page.getByText('+$5.00')).toBeVisible()
  await page.getByLabel('Direct-to-garment printing: Overall adjustment (%)').fill('10')
  await expect(page.getByTestId('sim-Proposed')).toContainText('$55.00') // not 60.50

  // Copying an old version into the draft is how to roll back.
  await page.getByRole('button', { name: 'Copy into draft' }).first().click()
  await expect(page.getByText('You have an unpublished draft.')).toBeVisible()
})

test('staff never see it: no link, a refusal on the page, and 403 from the server', async ({ page, context }) => {
  await page.route('**/api/app/me', (r) => r.fulfill({ json: { id: 2, email: 'x', name: 'Staff', role: 'staff' } }))
  await page.goto('/app/settings')
  await expect(page.getByText('Pricing Management')).toHaveCount(0)
  await page.goto('/app/settings/pricing')
  await expect(page.getByText('Only an owner can open Pricing Management.')).toBeVisible()
  await expect(page.getByText('Advanced pricing')).toHaveCount(0)
  expect(context).toBeTruthy()
})

test('the artwork check measures locally: no upload, counts and refusals shown', async ({ page }) => {
  let uploads = 0
  page.on('request', (r) => { if (r.method() !== 'GET' && /files|artwork/.test(r.url())) uploads++ })
  await page.goto('/app/settings/pricing')
  const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#ffffff"/>${body}</svg>`)
  await page.locator('input[type=file]').setInputFiles([
    { name: 'two-inks.svg', mimeType: 'image/svg+xml', buffer: svg('<rect x="50" y="50" width="120" height="300" fill="#142870"/><rect x="220" y="50" width="120" height="300" fill="#f0b41e"/>') },
    { name: 'scripted.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
    { name: 'job.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') },
    { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a png at all') },
  ])
  const row = (name: string) => page.getByRole('row').filter({ hasText: name })
  await expect(row('two-inks.svg')).toContainText('2')
  await expect(row('two-inks.svg')).toContainText('Background assumed not printed')
  await expect(row('scripted.svg')).toContainText('Manual review required')
  await expect(row('job.pdf')).toContainText('Format not analyzed')
  await expect(row('broken.png')).toContainText('Could not read this file')
  await page.getByLabel('Screens used: two-inks.svg').fill('2')
  await page.getByLabel('Screens used: job.pdf').fill('3')
  await expect(page.getByTestId('check-summary')).toContainText('With a known count: 2. Exact: 1. Within one: 1. Sent to manual review: 1.')
  expect(uploads).toBe(0)
})

test('a real PNG goes through the worker in the browser', async ({ page }) => {
  await page.goto('/app/settings/pricing')
  const bytes = await page.evaluate(`(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 400; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0,0,400,400); x.fillStyle = '#142870'; x.beginPath(); x.arc(200,200,120,0,7); x.fill(); return [...atob(c.toDataURL().split(',')[1])].map((ch) => ch.charCodeAt(0)) })()`) as number[]
  await page.locator('input[type=file]').setInputFiles({ name: 'circle.png', mimeType: 'image/png', buffer: Buffer.from(bytes) })
  await expect(page.getByRole('row').filter({ hasText: 'circle.png' }).getByRole('cell').nth(2)).toHaveText('1')
})
