// Preliminary estimates on the real pages: the customer's two outcomes, then the staff review on the stored file. Rates are test numbers only.
import { expect, test, type Page } from '@playwright/test'
import { reseed } from './prepare.ts'

const WORDING = 'This estimate is based on your selections and uploaded artwork. Our team will review your request and send you a final quote for approval. Pricing may change after review.'
test.afterAll(() => { reseed() })
let visitor = 0
test.beforeEach(async ({ page }) => {
  reseed()
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': `198.18.${process.pid % 250}.${++visitor}` })
})

async function publish(page: Page) {
  const config = { productCostCents: { tshirts: 300 }, services: { screen: { adjustmentBps: 0, pricing: { mode: 'markup', rateBps: 10000 }, colorCostTiers: [{ minQty: 1, costCents: 100 }], screenFee: { sellCents: 1000, costCents: 400 }, sizeCostCents: { small: 0, medium: 0, large: 0 } } } }
  expect((await page.request.put('/api/app/pricing/draft', { data: { config, expectedHash: null } })).status()).toBe(200)
  const draft = ((await (await page.request.get('/api/app/pricing')).json()) as { draft: { id: number; hash: string } }).draft
  expect((await page.request.post('/api/app/pricing/publish', { data: { draftId: draft.id, draftHash: draft.hash, expectedActiveId: null } })).status()).toBe(200)
}
/** A real PNG, drawn and encoded by the browser: two flat inks on white. */
const twoInks = async (page: Page) => Buffer.from(await page.evaluate(`(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 400; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0,0,400,400); x.fillStyle = '#0000ff'; x.fillRect(40,40,140,320); x.fillStyle = '#ff0000'; x.fillRect(220,40,140,320); return c.toDataURL('image/png').split(',')[1] })()`) as string, 'base64')

async function toReview(page: Page, name: string, withPrint = true) {
  await page.goto('/order')
  const png = await twoInks(page)
  await page.getByRole('checkbox', { name: /^T-shirts/ }).check({ force: true })
  await page.getByRole('radiogroup', { name: /T-shirts/ }).getByRole('radio', { name: 'Screen printing' }).check({ force: true })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('region', { name: /^T-shirts/ }).getByLabel('M', { exact: true }).fill('10')
  await page.getByRole('button', { name: 'Continue to artwork' }).click()
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'two-inks.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByText(/Uploaded\.$/)).toHaveCount(1)
  if (withPrint) {
    const prints = page.getByRole('region', { name: /^Print details/ })
    await prints.getByRole('button', { name: 'Add a print location' }).click()
    await prints.getByLabel('Where on the item').selectOption('front')
    await prints.getByLabel('Print size').selectOption('medium')
  }
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Email').fill('pat@example.com')
}
const openInquiry = async (page: Page, ref: string) => {
  await page.goto('/app/orders?view=inquiries')
  await page.getByRole('link', { name: ref }).click()
}

test('with nothing published the customer sees manual review, the page never asks for a price, and staff see why', async ({ page }) => {
  let asked = 0
  page.on('request', (r) => { if (r.url().includes('/api/public/estimate')) asked++ })
  await toReview(page, 'Off Person')
  await expect(page.getByText('Manual review required')).toBeVisible()
  await expect(page.getByText(/Preliminary estimate:/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page.getByRole('heading', { name: 'Thanks. We have your request.' })).toBeVisible()
  await expect(page.getByText('Manual review required')).toBeVisible()
  expect(asked).toBe(0)
  await openInquiry(page, (await page.locator('.s-ref strong').innerText()).trim())
  const card = page.getByRole('region', { name: 'Preliminary estimate' })
  await expect(card).toContainText('Manual review required')
  await expect(card).toContainText('No pricing was published.')
  await expect(card).toContainText('no published pricing')
})

test('switched on: one figure in the agreed words, then staff re-analyze the stored file and an override is audited', async ({ page }) => {
  test.setTimeout(120_000)
  await publish(page)
  await toReview(page, 'On Person')
  await expect(page.getByText('Preliminary estimate: $120.00')).toBeVisible()
  await expect(page.getByText(WORDING)).toBeVisible()
  const body = await page.locator('.s-estimate').innerText()
  expect(body).not.toMatch(/cost|margin|markup/i)
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page.getByRole('heading', { name: 'Thanks. We have your request.' })).toBeVisible()
  await expect(page.getByText('Preliminary estimate: $120.00')).toBeVisible()
  await expect(page.getByText('You get a quote and a proof')).toBeVisible()

  await openInquiry(page, (await page.locator('.s-ref strong').innerText()).trim())
  const card = page.getByRole('region', { name: 'Preliminary estimate' })
  await expect(card).toContainText('Not a quote')
  await expect(card).toContainText('Calculated: $120.00')
  await expect(card).toContainText('not verified')
  await expect(card).toContainText('Shown to the customer: $120.00')
  await expect(page.getByText('Full front, medium, two-inks.png')).toBeVisible()

  await card.getByRole('button', { name: 'Review artwork and details' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('reanalysis')).toContainText('Estimated ink colors: 2')
  const save = dialog.getByRole('button', { name: 'Save review' })
  await expect(save).toBeDisabled() // not until someone says they looked at the original
  await dialog.getByLabel('Ink colors').fill('3')
  await dialog.getByLabel('I compared this with the stored original file.').check()
  await save.click()
  await expect(dialog.getByText('Say why these details changed.')).toBeVisible()
  await dialog.getByLabel('Reason for changes').fill('Third color on the sleeve')
  await save.click()
  await expect(dialog).toHaveCount(0)
  await expect(card).toContainText('Calculated: $150.00')
  await expect(card).toContainText('Staff reviewed')
  await expect(card.getByTestId('overrides')).toContainText('line1.print1.colors: 2 → 3.')
  await expect(card.getByTestId('overrides')).toContainText('Third color on the sleeve')
  // The customer's own estimate is still there, unchanged, and the owner alone sees cost.
  await expect(card).toContainText('Shown to the customer: $120.00')
  await expect(card.getByTestId('estimate-internal').first()).toContainText('Owner only')
  // Nothing became a quote.
  await expect(page.getByRole('link', { name: /^\d{4}-/ })).toHaveCount(0)

  // Converted: the order says who verified what, the count included, and the review closes.
  await page.getByRole('button', { name: 'Convert to order' }).click()
  const convert = page.getByRole('dialog')
  await expect(convert.getByTestId('convert-specs')).toContainText('staff-verified')
  await convert.getByRole('button', { name: 'Create order' }).click()
  await expect(page).toHaveURL(/\/app\/orders\/\d{4}-/)
  await expect(page.getByText(/Staff verified at review \(.*\): Full front, medium, 3 ink colors\./)).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('button', { name: 'Review artwork and details' })).toHaveCount(0)
})

test('an estimate failure never stops the request: no print details means manual review, and sending works', async ({ page }) => {
  await publish(page)
  await toReview(page, 'Plain Person', false)
  await expect(page.getByText('Manual review required')).toBeVisible()
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page.getByRole('heading', { name: 'Thanks. We have your request.' })).toBeVisible()
})
