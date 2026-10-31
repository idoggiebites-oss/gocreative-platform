import { expect, test, type Page } from '@playwright/test'
import { makeOrder } from './helpers.ts'
import { reseed } from './prepare.ts'

// M1d: customers, new orders, items, quotes and authorization, end to end on the seeded e2e database.
test.afterAll(() => {
  reseed() // these tests create customers and orders in the local D1
})

const row = (page: Page, key: string) => page.locator(`[data-readiness="${key}"]`)
const fits = async (page: Page, path: string) => {
  const scroll = (await page.evaluate('document.documentElement.scrollWidth')) as number
  const width = (await page.evaluate('window.innerWidth')) as number
  expect(scroll, path).toBeLessThanOrEqual(width)
}

async function createCustomer(page: Page, name: string, kind: string) {
  await page.goto('/app/customers')
  await page.getByRole('button', { name: 'New customer' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('Type').selectOption({ label: kind })
  await dialog.getByRole('button', { name: 'Create customer' }).click()
  await expect(page).toHaveURL(/\/app\/customers\/\d+$/)
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
}

async function addContact(page: Page, name: string, primary = false) {
  await page.getByRole('button', { name: 'Add contact' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill(name)
  if (primary) await dialog.getByLabel('Make primary').check()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
}

async function fillProduct(page: Page, n: number, product: string, sizes: Record<string, number>, price: string) {
  const item = page.getByRole('group', { name: `Item ${n}` })
  await item.getByLabel('Product', { exact: true }).fill(product)
  for (const [size, qty] of Object.entries(sizes)) await item.getByLabel(`Size ${size}, item ${n}`).fill(String(qty))
  await item.getByLabel('Unit price').fill(price)
}

test('desktop: customer, order with a size grid, quote, acceptance and direct authorization', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  const name = `E2E Individual ${Date.now()}`
  await createCustomer(page, name, 'Individual')

  // contacts: an archived contact is not offered on a new order
  await addContact(page, 'Archie Archived')
  await page.getByRole('button', { name: 'Archive Archie Archived' }).click()
  await expect(page.getByRole('row', { name: /Archie Archived/ }).getByText('Archived', { exact: true })).toBeVisible()
  await addContact(page, 'Pat Primary', true)
  await expect(page.getByRole('row', { name: /Pat Primary/ }).getByText('Primary', { exact: true })).toBeVisible()

  await page.getByRole('main').getByRole('link', { name: 'New order' }).click()
  await expect(page).toHaveURL(/\/app\/orders\/new\?customer=\d+$/)
  await expect(page.getByRole('combobox', { name: 'Customer' })).toHaveValue(name)
  const contact = page.getByLabel(/^Contact/)
  await expect(contact).toHaveValue(/\d+/) // the primary is preselected
  await expect(contact.locator('option', { hasText: 'Pat Primary' })).toHaveCount(1)
  await expect(contact.locator('option', { hasText: 'Archie Archived' })).toHaveCount(0)
  await expect(page.getByLabel('PO required')).not.toBeChecked() // an individual's default

  // validation shows in place before anything is sent
  await page.getByRole('button', { name: 'Save order' }).click()
  await expect(page.getByText('Enter an order title.')).toBeVisible()

  await page.getByLabel('Order title').fill('E2E spirit wear')
  await fillProduct(page, 1, 'Heavy cotton tee', { M: 10, L: 5 }, '12')
  await page.getByRole('button', { name: 'Add item', exact: true }).click()
  await fillProduct(page, 2, 'Pullover hoodie', { S: 4 }, '$30.00')
  await expect(page.getByRole('group', { name: 'Item 1' }).getByLabel('Quantity')).toHaveValue('15')
  await expect(page.getByText('Items subtotal (19 pieces)')).toBeVisible()
  await expect(page.getByText('$300.00', { exact: true }).first()).toBeVisible() // 15 x 12 + 4 x 30

  await page.getByRole('button', { name: 'Save & create quote v1' }).click()
  await expect(page).toHaveURL(/\/app\/orders\/\d{4}-\d{4}$/)

  // quote exists as a draft: accept it from the checklist
  await expect(row(page, 'quote')).toContainText('Pending')
  await row(page, 'quote').getByRole('button', { name: 'Accept quote' }).click()
  await expect(row(page, 'quote')).toContainText('Complete')
  await expect(page.getByText('Locked', { exact: true })).toBeVisible()

  // direct authorization (no PO on this order)
  await expect(row(page, 'authorization')).toContainText('Pending')
  await row(page, 'authorization').getByRole('button', { name: 'Record authorization' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Record', exact: true }).click()
  await expect(row(page, 'authorization')).toContainText('Complete')
  await expect(row(page, 'quote')).toContainText('Complete')

  // a customer-facing edit after acceptance makes the quote stale again
  await page.getByRole('button', { name: 'Edit items' }).click()
  await page.getByRole('group', { name: 'Item 1' }).getByLabel('Size M, item 1').fill('12')
  await page.getByRole('button', { name: 'Save items' }).click()
  await expect(page.getByText('The order items changed after this quote was accepted.')).toBeVisible()
  await expect(row(page, 'quote')).toContainText('Pending')
  await expect(row(page, 'quote').getByRole('button', { name: 'New quote version' })).toBeVisible()

  // revoking needs a reason
  await page.getByRole('button', { name: 'Revoke authorization' }).click()
  const revoke = page.getByRole('dialog')
  await expect(revoke.getByRole('button', { name: 'Revoke', exact: true })).toBeDisabled()
  await revoke.getByLabel('Reason for revoking').fill('Customer changed the order')
  await revoke.getByRole('button', { name: 'Revoke', exact: true }).click()
  await expect(row(page, 'authorization')).toContainText('Pending')
})

test('desktop: a PO-required order hides direct authorization', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  const name = `E2E District ${Date.now()}`
  await createCustomer(page, name, 'School district')
  await page.getByRole('main').getByRole('link', { name: 'New order' }).click()
  await expect(page.getByLabel('PO required')).toBeChecked()
  await page.getByLabel('Order title').fill('E2E PO order')
  await fillProduct(page, 1, 'Tee', { M: 3 }, '10')
  await page.getByRole('button', { name: 'Save order' }).click()
  await expect(page).toHaveURL(/\/app\/orders\/\d{4}-\d{4}$/)
  await expect(row(page, 'authorization')).toContainText('Pending')
  await expect(page.getByRole('button', { name: /^Record authorization/ })).toHaveCount(0)
  await expect(page.getByText('requires a purchase order, so direct authorization does not apply')).toBeVisible()
})

test('desktop: the new screens are translated to Spanish', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  await page.goto('/app/orders/new')
  await page.getByRole('button', { name: 'Español' }).click()
  await expect(page.getByRole('heading', { name: 'Nuevo pedido', level: 1 })).toBeVisible()
  await expect(page.getByText('Fecha de entrega solicitada')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Guardar y crear cotización v1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Guardar pedido' })).toBeDisabled() // no customer chosen yet
  await page.getByRole('combobox', { name: 'Cliente' }).fill('Cedar')
  await page.getByRole('option', { name: /Cedar Hollow ISD/ }).click()
  await page.getByRole('button', { name: 'Guardar pedido' }).click()
  await expect(page.getByText('Escribe un título para el pedido.')).toBeVisible()

  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Clientes' }).click()
  await expect(page.getByRole('heading', { name: 'Clientes', level: 1 })).toBeVisible()
  await page.getByRole('link', { name: 'Cedar Hollow ISD' }).click()
  await expect(page.getByRole('heading', { name: 'Contactos' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Historial de pedidos' })).toBeVisible()

  const firstOrder = (await page.getByRole('link', { name: /^\d{4}-\d{4}$/ }).first().textContent())!
  await page.goto(`/app/orders/${firstOrder}`)
  await expect(page.getByRole('heading', { name: 'Lista de preparación' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Artículos y cotización' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Pagos' })).toBeVisible()
})

test('search finds customers from the list and the palette', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  await page.goto('/app/customers')
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('Cedar')
  await expect(page).toHaveURL(/q=Cedar/)
  await expect(page.getByRole('link', { name: 'Cedar Hollow ISD' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Riverbend Unified School District' })).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('')
  await page.getByLabel('Customer type').selectOption({ label: 'Individual' })
  await expect(page).toHaveURL(/kind=individual/)
  await expect(page.getByRole('link', { name: 'Dana Whitfield' })).toBeVisible()

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
  await expect(page.getByRole('option', { name: 'New order' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'New customer' })).toBeVisible()
  await page.getByRole('combobox').fill('Maple')
  await expect(page.getByRole('option', { name: 'Maple Ridge School District', exact: true })).toBeVisible()
})

test('phone: new order and customer pages fit at 390px', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone')
  await page.goto('/app/orders/new')
  await expect(page.getByRole('heading', { name: 'New order', level: 1 })).toBeVisible()
  await fits(page, '/app/orders/new')
  await page.getByLabel('Order title').fill('Phone check')
  await fillProduct(page, 1, 'Tee', { YS: 1, M: 2, '3XL': 3 }, '9.50')
  await page.getByRole('button', { name: 'Add charge' }).click()
  await fits(page, '/app/orders/new with items')
  await page.goto('/app/customers')
  await expect(page.getByRole('heading', { name: 'Customers', level: 1 })).toBeVisible()
  await fits(page, '/app/customers')
  await page.getByRole('link', { name: 'Cedar Hollow ISD' }).click()
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()
  await fits(page, '/app/customers/:id')
})

test('phone: the order workspace tabs, quote actions and authorization dialog are reachable at 390px', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone')
  const { number, version } = await makeOrder(page, 'Phone workspace')
  expect((await page.request.post(`/api/app/orders/${number}/quotes`, { data: { expectedVersion: version } })).ok()).toBe(true)
  await page.goto(`/app/orders/${number}`)
  await expect(page.getByRole('heading', { name: 'Phone workspace', level: 1 })).toBeVisible()
  const width = (await page.evaluate('window.innerWidth')) as number
  // Visible AND inside the viewport once scrolled to: a control cut off by the screen edge is unreachable.
  const reachable = async (loc: ReturnType<Page['locator']>, what: string) => {
    await loc.scrollIntoViewIfNeeded()
    await expect(loc, what).toBeVisible()
    const box = (await loc.boundingBox())!
    expect(box.x, `${what} left edge`).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, `${what} right edge`).toBeLessThanOrEqual(width)
  }

  for (const tab of ['Items & quote', 'Artwork', 'Purchase order', 'Production', 'Activity']) {
    const t = page.getByRole('tab', { name: tab })
    await t.scrollIntoViewIfNeeded()
    await t.click()
    await expect(t).toHaveAttribute('aria-selected', 'true')
    await reachable(t, `tab ${tab}`)
    await reachable(page.getByRole('tabpanel'), `panel ${tab}`)
    await fits(page, `order tab ${tab}`)
  }

  await page.getByRole('tab', { name: 'Items & quote' }).click()
  for (const name of ['Duplicate', 'New version', 'Refresh draft', 'Mark sent', 'Accept', 'Decline']) await reachable(page.getByRole('button', { name, exact: true }), `quote action ${name}`)

  const record = page.locator('[data-panel="authorization"]').getByRole('button', { name: 'Record authorization' })
  await reachable(record, 'Record authorization')
  await record.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  for (const name of ['Cancel', 'Record']) await reachable(dialog.getByRole('button', { name, exact: true }), `dialog ${name}`)
  await reachable(dialog.getByLabel('How they authorized'), 'dialog method')
  await fits(page, 'authorization dialog')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(record).toBeFocused()
})
