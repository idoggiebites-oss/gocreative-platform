import { expect, test, type Page } from '@playwright/test'
import { makeOrder } from './helpers.ts'
import { reseed } from './prepare.ts'

// M2b: artwork designs, versions and approvals, purchase orders and their documents, on the seeded e2e database.
test.afterAll(() => {
  reseed()
})

const fx = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname
const row = (page: Page, key: string) => page.locator(`[data-readiness="${key}"]`)
const fits = async (page: Page) => {
  const scroll = (await page.evaluate('document.documentElement.scrollWidth')) as number
  const width = (await page.evaluate('window.innerWidth')) as number
  expect(scroll).toBeLessThanOrEqual(width)
}
const dialog = (page: Page) => page.getByRole('dialog')

async function openTab(page: Page, number: string, tab: string) {
  await page.goto(`/app/orders/${number}`)
  await page.getByRole('tab', { name: tab }).click()
}

async function newDesign(page: Page, file: string, name?: string) {
  await page.getByRole('button', { name: 'New design' }).click()
  if (name) await dialog(page).getByLabel('Design name (optional)').fill(name)
  await dialog(page).locator('input[type=file]').setInputFiles(fx(file))
  await dialog(page).getByRole('button', { name: 'Upload', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
}

test('artwork: upload, approve, new version resets it, request changes, older version is read-only', async ({ page }) => {
  const o = await makeOrder(page, 'Artwork flow')
  await openTab(page, o.number, 'Artwork')
  await expect(row(page, 'artwork').getByText('Pending')).toBeVisible()

  await newDesign(page, 'crest.png', 'Front crest')
  const design = page.getByRole('region', { name: 'Front crest' })
  await expect(design.getByText('v1 · Under review')).toBeVisible()
  await expect(design.locator('img')).toBeVisible()

  // Approving needs a method.
  await design.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(dialog(page).getByRole('button', { name: 'Approve', exact: true })).toBeDisabled()
  await dialog(page).getByLabel('How did the customer approve?').selectOption('email')
  await dialog(page).getByLabel('Internal note (optional)').fill('Mom confirmed by email')
  await dialog(page).getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(design.getByText('v1 · Approved')).toBeVisible()
  await expect(design.getByText(/Approved by email on/)).toBeVisible()
  await expect(row(page, 'artwork').getByText('Complete')).toBeVisible()

  // A new version starts under review and the checklist reopens.
  await design.getByRole('button', { name: 'Upload new version' }).click()
  await dialog(page).locator('input[type=file]').setInputFiles(fx('crest-v2.png'))
  await dialog(page).getByRole('button', { name: 'Upload', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(design.getByText('v2 · Under review')).toBeVisible()
  await expect(row(page, 'artwork').getByText('Pending')).toBeVisible()
  // Version 1 is older: no actions.
  const v1 = design.locator('[data-version="1"]')
  await expect(v1.getByRole('button')).toHaveCount(0)
  await expect(design.locator('[data-version="2"]').getByRole('button', { name: 'Approve', exact: true })).toBeVisible()

  // Request changes on the current version.
  await design.getByRole('button', { name: 'Request changes' }).click()
  await dialog(page).getByLabel('What should change? (optional)').fill('Make it bigger')
  await dialog(page).getByRole('button', { name: 'Request changes' }).click()
  await expect(design.getByText('v2 · Changes requested')).toBeVisible()
  await fits(page)
})

test('artwork: SVG previews through img and downloads; a renamed HTML file and an oversized-type file are refused', async ({ page }) => {
  const o = await makeOrder(page, 'Artwork svg')
  await openTab(page, o.number, 'Artwork')
  await newDesign(page, 'logo.svg', 'Logo')
  const img = page.getByRole('region', { name: 'Logo' }).locator('img')
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((i) => (i as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0)
  const src = (await img.getAttribute('src'))!
  expect(src).toMatch(/^\/api\/app\/files\/\d+$/)
  expect(await page.locator('object, iframe, embed').count()).toBe(0)
  const res = await page.request.get(src)
  expect(res.headers()['content-disposition']).toMatch(/^attachment/)

  // The server refuses an HTML file named .png.
  await page.getByRole('button', { name: 'New design' }).click()
  await dialog(page).locator('input[type=file]').setInputFiles(fx('not-an-image.png'))
  await dialog(page).getByRole('button', { name: 'Upload', exact: true }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('That file type is not accepted')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()

  // Client-side: a disallowed extension never leaves the browser.
  await page.getByRole('button', { name: 'New design' }).click()
  await dialog(page).locator('input[type=file]').setInputFiles({ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<p>x</p>') })
  await expect(dialog(page).getByRole('alert')).toContainText('That file type is not accepted')
  await expect(dialog(page).getByRole('button', { name: 'Upload', exact: true })).toBeDisabled()
})

test('artwork: TIFF falls back to a card with Download; PDF has a View link', async ({ page }) => {
  const o = await makeOrder(page, 'Artwork tiff pdf')
  await openTab(page, o.number, 'Artwork')
  await newDesign(page, 'scan.tif', 'Scan')
  const scan = page.getByRole('region', { name: 'Scan' })
  await expect(scan.getByRole('link', { name: /Download/ })).toBeVisible()
  await newDesign(page, 'po.pdf', 'Proof')
  const proof = page.getByRole('region', { name: 'Proof' })
  const view = proof.getByRole('link', { name: /^View/ })
  await expect(view).toHaveAttribute('target', '_blank')
  await expect(view).toHaveAttribute('href', /\/api\/app\/files\/\d+$/)
})

test('purchase order: create, add a document, replacing an approved PO needs a reason', async ({ page }) => {
  const o = await makeOrder(page, 'PO flow', undefined, { poRequired: true })
  await openTab(page, o.number, 'Purchase order')
  await page.getByRole('button', { name: 'Add PO' }).click()
  await dialog(page).getByLabel('PO number').fill('PO-7781')
  await dialog(page).getByLabel('Amount (USD)').fill('1,250.50')
  await dialog(page).getByRole('button', { name: 'Create PO' }).click()
  const po = page.locator('[data-po]').first()
  await expect(po).toContainText('PO-7781')
  await expect(po).toContainText('$1,250.50')

  await po.getByRole('button', { name: 'Upload document' }).click()
  await dialog(page).locator('input[type=file]').setInputFiles(fx('po.pdf'))
  await dialog(page).getByRole('button', { name: 'Upload', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(po.getByText('po.pdf')).toBeVisible()
  await expect(po.getByRole('link', { name: /^View/ })).toBeVisible()
  await expect(po.getByRole('link', { name: /^Download/ })).toBeVisible()

  // Edit the details while it is not approved.
  await po.getByRole('button', { name: 'Edit details' }).click()
  await dialog(page).getByLabel('Amount (USD)').fill('1300')
  await dialog(page).getByRole('button', { name: 'Save' }).click()
  await expect(po).toContainText('$1,300.00')

  // Approve it (received -> under review -> approved), then a replacement needs a reason and the old one locks.
  for (const step of ['Received', 'Under review', 'Approved']) {
    await po.getByRole('button', { name: /Purchase order:/ }).click()
    await page.getByRole('menuitem', { name: step, exact: true }).click()
    await expect(po.getByRole('button', { name: new RegExp(`Purchase order: ${step}`) })).toBeVisible()
  }
  await expect(po.getByRole('button', { name: 'Edit details' })).toBeDisabled()
  await expect(po.getByText('Approved purchase orders can’t be changed')).toBeVisible()

  await page.getByRole('button', { name: 'Add PO' }).click()
  await expect(dialog(page).getByText('The latest PO is already approved')).toBeVisible()
  await dialog(page).getByLabel('PO number').fill('PO-7782')
  await expect(dialog(page).getByRole('button', { name: 'Create PO' })).toBeDisabled()
  await dialog(page).getByLabel('Why is a new PO replacing the approved one?').fill('Customer reissued the PO')
  await dialog(page).getByRole('button', { name: 'Create PO' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.locator('[data-po]').first()).toContainText('PO-7782')
  await fits(page)
})

test('purchase order: no creation when the order needs none', async ({ page }) => {
  const o = await makeOrder(page, 'No PO', undefined, { poRequired: false })
  await openTab(page, o.number, 'Purchase order')
  await expect(page.getByText('This order does not need a purchase order.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add PO' })).toHaveCount(0)
})

test('checklist actions lead to the artwork and PO tabs', async ({ page }) => {
  const o = await makeOrder(page, 'Checklist', undefined, { poRequired: true })
  await page.goto(`/app/orders/${o.number}`)
  await row(page, 'artwork').getByRole('button', { name: 'Upload artwork' }).click()
  await expect(page.getByRole('button', { name: 'New design' })).toBeVisible()
  await row(page, 'authorization').getByRole('button', { name: 'Request PO' }).click()
  await expect(page.getByRole('button', { name: 'Add PO' })).toBeVisible()
})

test('Spanish labels and the customer saved-artwork row', async ({ page }) => {
  const o = await makeOrder(page, 'Spanish artwork')
  await page.goto(`/app/orders/${o.number}`)
  await page.evaluate(() => localStorage.setItem('lang', 'es'))
  await page.reload()
  await page.getByRole('tab', { name: 'Diseño', exact: true }).click()
  await page.getByRole('button', { name: 'Nuevo diseño' }).click()
  await dialog(page).getByLabel('Nombre del diseño (opcional)').fill('Escudo')
  await dialog(page).locator('input[type=file]').setInputFiles(fx('crest.png'))
  await dialog(page).getByRole('button', { name: 'Subir', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  const design = page.getByRole('region', { name: 'Escudo' })
  await expect(design.getByText('v1 · En revisión')).toBeVisible()
  await design.getByRole('button', { name: 'Aprobar' }).click()
  await dialog(page).getByLabel('¿Cómo aprobó el cliente?').selectOption('phone')
  await dialog(page).getByRole('button', { name: 'Aprobar' }).click()
  await expect(design.getByText(/Aprobado por teléfono el/)).toBeVisible()
  await expect(design.getByRole('button', { name: 'Solicitar cambios' })).toBeVisible()
  await page.getByRole('tab', { name: 'Orden de compra' }).click()
  await expect(page.getByText('Esta orden no necesita una orden de compra.').or(page.getByRole('button', { name: 'Agregar OC' }))).toBeVisible()

  await page.goto(`/app/customers/${o.customerId}`)
  const saved = page.getByRole('region', { name: 'Arte guardado' })
  await expect(saved.getByRole('link', { name: 'Escudo' })).toHaveAttribute('href', `/app/orders/${o.number}`)
  await expect(saved.getByText('1 versión')).toBeVisible()
  await fits(page)
  await page.evaluate(() => localStorage.setItem('lang', 'en'))
  await page.reload()
  await expect(page.getByRole('region', { name: 'Saved artwork' }).locator('img')).toBeVisible()
})
