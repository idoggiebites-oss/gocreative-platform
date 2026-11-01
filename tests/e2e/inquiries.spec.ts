// A real request end to end: the storefront to the dashboard to an order, on the real local API.
import { expect, test, type Page } from '@playwright/test'
import { reseed } from './prepare.ts'

test.afterAll(() => { reseed() })
let visitor = 0
test.beforeEach(async ({ page }) => { await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': `198.19.${process.pid % 250}.${++visitor}` }) })

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex')
const artwork = (page: Page) => page.locator('input[type=file][multiple]')

async function sendMultiProduct(page: Page, who: string) {
  await page.goto('/order')
  for (const p of [/^T-shirts/, /^Polos/, /^Hats/]) await page.getByRole('checkbox', { name: p }).check({ force: true })
  await page.getByRole('radiogroup', { name: /T-shirts/ }).getByRole('radio', { name: 'Screen printing' }).check({ force: true })
  await page.getByRole('radiogroup', { name: /Polos/ }).getByRole('radio', { name: 'Embroidery' }).check({ force: true })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  const shirts = page.getByRole('region', { name: /^T-shirts/ })
  await shirts.getByLabel('M', { exact: true }).fill('20')
  await shirts.getByLabel('L', { exact: true }).fill('14')
  await shirts.getByLabel(/color/).fill('Navy')
  await page.getByRole('region', { name: /^Polos/ }).getByLabel('L', { exact: true }).fill('6')
  await page.getByRole('region', { name: /^Hats/ }).getByLabel('Quantity').fill('12')
  await page.getByRole('textbox', { name: 'Project description (optional)' }).fill('Left chest logo. Spring banquet.')
  await page.getByLabel(/Requested deadline/).fill('2031-05-01')
  await page.getByRole('button', { name: 'Continue to artwork' }).click()
  await page.getByLabel('Ordering for a school, district or organization').check()
  await artwork(page).setInputFiles([{ name: 'eagles.png', mimeType: 'image/png', buffer: PNG }])
  await page.locator('input[type=file]:not([multiple])').setInputFiles({ name: 'po-4471.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n') })
  await expect(page.getByText(/Uploaded\.$/)).toHaveCount(2)
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await page.getByRole('textbox', { name: 'School, district or organization' }).fill('Valley ISD')
  await page.getByLabel('Your name').fill(who)
  await page.getByLabel('Email').fill(`${who.split(' ')[0].toLowerCase()}@example.com`)
}

test('the final review shows exactly what is stored, and editing a step loses nothing', async ({ page }) => {
  await sendMultiProduct(page, 'Review Person')
  const review = page.getByRole('region', { name: 'Review your request' })
  // Edit from the review, change one quantity; the rest of the request must survive the round trip.
  await page.getByRole('button', { name: 'Edit your project' }).click()
  const shirts = page.getByRole('region', { name: /^T-shirts/ })
  await expect(shirts.getByLabel('M', { exact: true })).toHaveValue('20')
  await expect(shirts.getByLabel('L', { exact: true })).toHaveValue('14')
  await expect(shirts.getByLabel(/color/)).toHaveValue('Navy')
  await expect(page.getByRole('region', { name: /^Hats/ }).getByLabel('Quantity')).toHaveValue('12')
  await shirts.getByLabel('M', { exact: true }).fill('25')
  await page.getByRole('button', { name: 'Continue to artwork' }).click()
  await expect(page.getByRole('list', { name: 'Your files' }).getByText('eagles.png')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Your files' }).getByText('po-4471.pdf')).toBeVisible()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await expect(page.getByLabel('Your name')).toHaveValue('Review Person')
  const shown = await review.innerText()
  for (const expected of ['T-shirts, screen printing: 39, Navy', 'Polos, embroidery: 6', 'Hats, embroidery: 12', 'Left chest logo. Spring banquet.', 'May 1, 2031', 'eagles.png', 'po-4471.pdf']) expect(shown).toContain(expected)
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page).toHaveURL(/order\/sent\//)

  const ref = page.url().split('/').pop()!
  const list = await (await page.request.get(`/api/app/orders?view=inquiries&q=${ref}`)).json() as { rows: { id: number }[] }
  const d = await (await page.request.get(`/api/app/inquiries/${list.rows[0].id}`)).json() as { lines: { product: string; method: string; quantity: number; sizes: Record<string, number> | null; color: string | null }[]; description: string; dueDate: string; files: { filename: string; kind: string }[]; contactName: string; organization: string }
  // What the customer saw, line for line, is what the database holds.
  expect(d.lines.map((l) => [l.product, l.method, l.quantity, l.sizes, l.color])).toEqual([
    ['T-shirts', 'screen', 39, { M: 25, L: 14 }, 'Navy'], ['Polos', 'embroidery', 6, { L: 6 }, null], ['Hats', 'embroidery', 12, null, null],
  ])
  expect(d).toMatchObject({ description: 'Left chest logo. Spring banquet.', dueDate: '2031-05-01', contactName: 'Review Person', organization: 'Valley ISD' })
  expect(d.files.map((f) => [f.filename, f.kind]).sort()).toEqual([['eagles.png', 'artwork'], ['po-4471.pdf', 'po']])
})

test('storefront to order: staff review, convert, and every line, file and unverified PO are on the order', async ({ page }) => {
  await sendMultiProduct(page, 'Convert Person')
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page).toHaveURL(/order\/sent\//)
  const ref = page.url().split('/').pop()!

  await page.goto('/app/orders?view=inquiries')
  await page.getByRole('link', { name: ref }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(ref)
  const request = page.getByRole('region', { name: 'What they asked for' })
  await expect(request).toContainText('T-shirts')
  await expect(request).toContainText('Polos')
  await expect(request).toContainText('Hats')
  await expect(page.getByText('Left chest logo. Spring banquet.')).toBeVisible()
  await expect(page.getByText('What the customer asked for, not a commitment.')).toBeVisible()
  await expect(page.getByText('Purchase order, unverified until staff approve it')).toBeVisible()

  await page.getByRole('button', { name: 'Convert to order' }).click()
  await expect(page.getByRole('dialog')).toContainText('purchase orders unverified')
  await expect(page.getByLabel('Due date')).toHaveValue('2031-05-01')
  await page.getByRole('button', { name: 'Create order' }).click()
  await expect(page).toHaveURL(/app\/orders\/\d{4}-\d{4}$/)
  const number = page.url().split('/').pop()!
  await expect(page.getByText('Valley ISD').first()).toBeVisible()
  const o = await (await page.request.get(`/api/app/orders/${number}`)).json() as { items: { product: string; quantity: number }[] }
  expect(o.items.map((i) => [i.product, i.quantity])).toEqual([['T-shirts', 34], ['Polos', 6], ['Hats', 12]])
  const po = await (await page.request.get(`/api/app/orders/${number}/purchase-orders`)).json() as { purchaseOrders: { status: string }[] }
  expect(po.purchaseOrders.map((p) => p.status)).toEqual(['received'])

  // Back on the inquiry: linked to its order, with no way to convert it twice.
  await page.goto('/app/orders?view=inquiries&status=converted')
  await page.getByRole('link', { name: ref }).click()
  await expect(page.getByRole('link', { name: number })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Convert to order' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0)
})

test('decline with a reason, move back, spam and owner delete, each from the screen', async ({ page }) => {
  await sendMultiProduct(page, 'Decline Person')
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page).toHaveURL(/order\/sent\//)
  const ref = page.url().split('/').pop()!
  await page.goto('/app/orders?view=inquiries')
  await page.getByRole('link', { name: ref }).click()
  await page.getByRole('button', { name: 'Decline', exact: true }).click()
  await page.getByLabel('Reason (optional, internal)').fill('Not something we make')
  await page.getByRole('button', { name: 'Decline inquiry' }).click()
  await expect(page.getByText('Declined: Not something we make')).toBeVisible()
  await page.getByRole('button', { name: 'Move back to new' }).click()
  await page.getByRole('button', { name: 'Mark as spam' }).click()
  await expect(page.getByRole('button', { name: 'Move back to new' })).toBeVisible()
  await page.getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(page).toHaveURL(/view=inquiries/)
  await page.goto('/app/orders?view=inquiries&status=spam')
  await expect(page.getByRole('link', { name: ref })).toHaveCount(0)
})

test('a missing inquiry says so', async ({ page }) => {
  await page.goto('/app/inquiries/999999')
  await expect(page.getByText('This inquiry is gone.')).toBeVisible()
})
