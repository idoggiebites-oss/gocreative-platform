import { expect, test, type Page } from '@playwright/test'
import { clearRunning } from './helpers.ts'
import { reseed } from './prepare.ts'

// M6: two whole order lifecycles driven through the real UI (clicks and typing). The API is used only to read state back,
// to send jobs left running by other specs to quality control (the shop runs one job at a time), and to prove a refusal.
// Together the steps cover the Phase 2 acceptance criteria 1-17 (SPEC-phase2.md section 18); each step names its numbers.
test.afterAll(() => {
  reseed()
})

const dialog = (page: Page) => page.getByRole('dialog')
const row = (page: Page, key: string) => page.locator(`[data-readiness="${key}"]`)
const fx = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname
const btn = (page: Page, action: string, n: string) => page.getByRole('button', { name: `${action}: ${n}`, exact: true })
const submit = (page: Page, name: string) => dialog(page).getByRole('button', { name, exact: true })
const productionChip = (page: Page) => page.getByRole('group', { name: 'Production' }).first()
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true }).click()

const detail = async (page: Page, n: string) => (await (await page.request.get(`/api/app/orders/${n}`)).json()) as { order: { state: string; version: number; productionStatus: string }; activity: { action: string }[] }
const paymentsOf = async (page: Page, n: string) => (await (await page.request.get(`/api/app/orders/${n}/payments`)).json()) as {
  payments: { voided: unknown }[]; checks: { status: string }[]; balance: { receivedCents: number; outstandingCents: number | null; agreedCents: number | null }
}

const outstandingRows = async (page: Page) =>
  ((await (await page.request.get('/api/app/payments')).json()) as { outstanding: { number: string; outstandingCents: number | null }[] }).outstanding

/** Acceptance 17: this order, specifically, is on the dashboard as "Ready for pickup" and owing money (the tile total is the sum of the rows). */
async function expectPendingOnDashboard(page: Page, n: string, owedCents: number) {
  await page.goto('/app')
  await expect(page.getByRole('region', { name: 'Ready for pickup', exact: true }).locator(`[data-ready="${n}"]`)).toBeVisible()
  const rows = await outstandingRows(page)
  expect(rows.find((r) => r.number === n)?.outstandingCents).toBe(owedCents)
  await expect(page.getByRole('region', { name: 'Outstanding payments' }).locator('[data-outstanding]')).toHaveAttribute('data-outstanding', String(rows.reduce((t, r) => t + (r.outstandingCents ?? 0), 0)))
}

async function createCustomer(page: Page, name: string, kind: string) {
  await page.goto('/app/customers')
  await page.getByRole('button', { name: 'New customer' }).click()
  await dialog(page).getByLabel('Name').fill(name)
  await dialog(page).getByLabel('Type').selectOption({ label: kind })
  await dialog(page).getByRole('button', { name: 'Create customer' }).click()
  await expect(page).toHaveURL(/\/app\/customers\/\d+$/)
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
}

async function fillProduct(page: Page, n: number, product: string, sizes: Record<string, number>, price: string) {
  const item = page.getByRole('group', { name: `Item ${n}` })
  await item.getByLabel('Product', { exact: true }).fill(product)
  for (const [size, qty] of Object.entries(sizes)) await item.getByLabel(`Size ${size}, item ${n}`).fill(String(qty))
  await item.getByLabel('Unit price').fill(price)
}

/** On the New order form: title, one product with sizes, "Save & create quote v1". Returns the order number. */
async function newOrder(page: Page, title: string) {
  await page.getByLabel('Order title').fill(title)
  await fillProduct(page, 1, 'Heavy cotton tee', { M: 3, L: 1 }, '12') // 4 pieces, $48.00
  await expect(page.getByText('Items subtotal (4 pieces)')).toBeVisible()
  await page.getByRole('button', { name: 'Save & create quote v1' }).click()
  await expect(page).toHaveURL(/\/app\/orders\/\d{4}-\d{4}$/)
  return page.url().split('/').pop()!
}

async function approveArtwork(page: Page) {
  await tab(page, 'Artwork')
  await page.getByRole('button', { name: 'New design' }).click()
  await dialog(page).getByLabel('Design name (optional)').fill('Front crest')
  await dialog(page).locator('input[type=file]').setInputFiles(fx('crest.png'))
  await submit(page, 'Upload').click()
  await expect(dialog(page)).toHaveCount(0)
  const design = page.getByRole('region', { name: 'Front crest' })
  await design.getByRole('button', { name: 'Approve', exact: true }).click()
  await dialog(page).getByLabel('How did the customer approve?').selectOption('email')
  await submit(page, 'Approve').click()
  await expect(design.getByText('v1 · Approved')).toBeVisible()
  await expect(row(page, 'artwork')).toContainText('Complete')
}

/** Orders list -> done through the Production page: Start, enter all units, QC, complete. Acceptance 9, 11. */
async function runProduction(page: Page, n: string, pieces: number) {
  await page.goto('/app/production')
  await btn(page, 'Start', n).click()
  const current = page.getByRole('region', { name: 'Currently in production' })
  await expect(current).toContainText(n)
  // 17: while it runs, this order is the dashboard's current production job
  await page.goto('/app')
  await expect(page.getByRole('region', { name: 'Current production job' })).toContainText(n)
  await page.goto('/app/production')
  await page.getByLabel(`Units completed (number): ${n}`).fill(String(pieces))
  await page.getByRole('button', { name: 'Save units' }).first().click()
  await expect(current.getByText(`${pieces} of ${pieces}`).first()).toBeVisible()
  await btn(page, 'Send to quality control', n).click() // 11
  await btn(page, 'Mark production complete', n).click()
  await expect(page.getByRole('region', { name: 'Completed production' }).getByRole('listitem').filter({ hasText: n })).toContainText('Production complete')
}

const activityHas = async (page: Page, n: string, texts: string[]) => {
  await page.goto(`/app/orders/${n}`)
  await tab(page, 'Activity')
  const panel = page.getByRole('tabpanel')
  for (const t of texts) await expect(panel, t).toContainText(t.replace('{n}', n))
}

test('regular customer: direct authorization, JDS purchase, pickup unpaid with an owner override, then paid in full', async ({ page }, info) => {
  test.skip(info.project.name === 'phone')
  test.setTimeout(90_000)
  await clearRunning(page)

  // 1, 2: customer, order, products with sizes and prices
  const name = `Lifecycle Regular ${Date.now()}`
  await createCustomer(page, name, 'Individual')
  await page.getByRole('main').getByRole('link', { name: 'New order' }).click()
  const n = await newOrder(page, 'Lifecycle spirit wear')

  // 3: a draft quote exists; the items change after it (price 12 -> 15), so the quote is stale and a new version is made
  await expect(row(page, 'quote')).toContainText('Pending')
  await page.getByRole('button', { name: 'Edit items' }).click()
  await page.getByRole('group', { name: 'Item 1' }).getByLabel('Unit price').fill('15')
  await page.getByRole('button', { name: 'Save items' }).click()
  await expect(page.getByText('The items changed after this quote was made.').first()).toBeVisible()
  await expect(row(page, 'quote').getByRole('button', { name: 'Accept quote' })).toHaveCount(0)
  await row(page, 'quote').getByRole('button', { name: 'New quote version' }).click()
  await expect(page.getByText('v2', { exact: true })).toBeVisible()
  // v1 is superseded: the server will not decline it (only a live draft or sent quote can be)
  const v1 = await page.request.patch(`/api/app/orders/${n}/quotes/1`, { data: { to: 'declined', expectedVersion: (await detail(page, n)).order.version } })
  expect(v1.status()).toBe(409)
  expect((await v1.json()).code).toBe('invalid_quote_transition')
  // 4: accept the new version; the order's total is the new one ($60.00 = 4 x $15.00)
  await row(page, 'quote').getByRole('button', { name: 'Accept quote' }).click()
  await expect(row(page, 'quote')).toContainText('Complete')
  await expect(page.getByText('$60.00', { exact: true }).first()).toBeVisible()

  // 6: direct authorization (no PO on this order)
  await row(page, 'authorization').getByRole('button', { name: 'Record authorization' }).click()
  await submit(page, 'Record').click()
  await expect(row(page, 'authorization')).toContainText('Complete')

  // 5: artwork upload and approval
  await approveArtwork(page)

  // 7, 8: a JDS purchase, marked ordered, delivered in full
  await row(page, 'materials').getByRole('button', { name: 'Add purchase' }).click()
  await expect(dialog(page).getByLabel('Supplier').locator('option:checked')).toHaveText('JDS (default)')
  await dialog(page).getByLabel('Description').fill('Heavy cotton tee, Navy')
  await dialog(page).getByLabel('Quantity').fill('4')
  await dialog(page).getByLabel('Estimated unit cost (USD)').fill('6.50')
  await submit(page, 'Add purchase').click()
  await expect(dialog(page)).toHaveCount(0)
  const purchase = page.getByRole('region', { name: 'Heavy cotton tee, Navy' })
  await purchase.getByRole('button', { name: 'Mark ordered' }).click()
  await submit(page, 'Mark ordered').click()
  await expect(purchase).toContainText('Ordered')
  await purchase.getByRole('button', { name: 'Record delivery' }).click()
  await expect(dialog(page).getByLabel('Quantity')).toHaveValue('4')
  await submit(page, 'Record delivery').click()
  await expect(purchase).toContainText('Received')
  await expect(row(page, 'materials')).toContainText('Complete')

  // 8: production preparation to Ready; the order shows Ready for production
  await expect(productionChip(page)).toContainText('Awaiting preparation')
  await tab(page, 'Production')
  await page.getByRole('button', { name: 'Ready', exact: true }).click()
  await expect(row(page, 'preparation')).toContainText('Complete')
  await expect(productionChip(page)).toContainText('Ready for production')

  // 9, 11: start from the Production page, units, QC, complete
  await runProduction(page, n, 4)
  await expectPendingOnDashboard(page, n, 6000) // 17: complete, so it is under Ready for pickup and owes money

  // 12, 13: it is ready for pickup; record the notification
  await page.goto(`/app/orders/${n}`)
  await tab(page, 'Pickup')
  await expect(page.getByText('Ready for pickup', { exact: true }).first()).toBeVisible() // 12
  await btn(page, 'Record notification', n).click()
  await submit(page, 'Record notification').click()
  await expect(page.getByText('Customer notified by phone on')).toBeVisible()

  // 13, 14: pickup of an unpaid pay-at-pickup order warns; the owner overrides with a reason
  await btn(page, 'Record pickup', n).click()
  await dialog(page).getByLabel('Collected by').fill('Pat Parent')
  await expect(dialog(page).getByRole('alert').filter({ hasText: 'still owes $60.00' })).toBeVisible()
  await expect(submit(page, 'Record pickup')).toBeDisabled()
  await dialog(page).getByRole('button', { name: 'Release anyway (override)' }).click()
  await dialog(page).getByLabel('Reason for releasing it unpaid').fill('Pays by mail on Friday')
  await submit(page, 'Record pickup').click()
  await expect(page.getByText(/Picked up by Pat Parent on/)).toBeVisible()
  await expect(page.getByText(/Released before payment by .*Pays by mail on Friday/)).toBeVisible()
  expect((await detail(page, n)).order.state).toBe('active') // picked up is not closed while unpaid

  // 14, 17: the unpaid order is on the dashboard's outstanding list; then payment in full closes it
  await page.goto('/app')
  await expect(page.getByRole('region', { name: 'Ready for pickup', exact: true }).locator(`[data-ready="${n}"]`)).toHaveCount(0) // picked up
  expect((await outstandingRows(page)).find((r) => r.number === n)?.outstandingCents).toBe(6000) // still owed
  await page.goto(`/app/orders/${n}`)
  await tab(page, 'Payments')
  await page.getByRole('button', { name: 'Record payment', exact: true }).click()
  await expect(dialog(page).getByLabel('Amount')).toHaveValue('60.00')
  await submit(page, 'Record payment').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => (await detail(page, n)).order.state).toBe('closed')
  const p = await paymentsOf(page, n)
  expect(p.payments).toHaveLength(1)
  expect(p.balance).toMatchObject({ receivedCents: 6000, outstandingCents: 0 })
  expect((await outstandingRows(page)).some((r) => r.number === n)).toBe(false) // paid: gone from outstanding

  // The history has the key events.
  await activityHas(page, n, [
    'Order created', 'Authorization recorded on {n}', 'Artwork decision recorded on {n}', 'Purchase marked as ordered on {n}', 'Delivery received on {n}',
    'Production started on {n}', 'Customer notified that {n} is ready for pickup', 'Order {n} picked up', 'Owner override: {n} released before payment',
    'Payment recorded on {n}', 'Order {n} closed: picked up and paid',
  ])
})

test('school district: PO gate, no purchasing, pickup before payment, check collected, deposited and cleared', async ({ page }, info) => {
  test.skip(info.project.name === 'phone')
  test.setTimeout(90_000)
  await clearRunning(page)

  // 1, 2: a district customer defaults to PO required and pay after pickup
  const name = `Lifecycle District ${Date.now()}`
  await createCustomer(page, name, 'School district')
  await page.getByRole('main').getByRole('link', { name: 'New order' }).click()
  await expect(page.getByLabel('PO required')).toBeChecked()
  await expect(page.getByLabel('Payment terms')).toHaveValue('due_after_pickup')
  const n = await newOrder(page, 'Lifecycle district shirts')
  await expect(row(page, 'authorization')).toContainText('Pending')
  await expect(page.getByRole('button', { name: /^Record authorization/ })).toHaveCount(0) // PO orders have no direct authorization

  // 3, 4: accept the quote
  await row(page, 'quote').getByRole('button', { name: 'Accept quote' }).click()
  await expect(row(page, 'quote')).toContainText('Complete')

  // 6: the PO record, its document, and review
  await tab(page, 'Purchase order')
  await page.getByRole('button', { name: 'Add PO' }).click()
  await dialog(page).getByLabel('PO number').fill('PO-9001')
  await dialog(page).getByLabel('Amount (USD)').fill('48')
  await submit(page, 'Create PO').click()
  const po = page.locator('[data-po]').first()
  await expect(po).toContainText('PO-9001')
  await po.getByRole('button', { name: 'Upload document' }).click()
  await dialog(page).locator('input[type=file]').setInputFiles(fx('po.pdf'))
  await submit(page, 'Upload').click()
  await expect(po.getByText('po.pdf')).toBeVisible()
  for (const step of ['Received', 'Under review']) {
    await po.getByRole('button', { name: /Purchase order:/ }).click()
    await page.getByRole('menuitem', { name: step, exact: true }).click()
    await expect(po.getByRole('button', { name: new RegExp(`Purchase order: ${step}`) })).toBeVisible()
  }
  await approveArtwork(page)

  // 7, 8: everything else the gate needs is done first (quote accepted, artwork approved, no purchasing needed, prep not required),
  // so the only thing left is the PO approval
  await row(page, 'materials').getByRole('button', { name: 'Confirm no purchasing needed' }).click()
  await dialog(page).getByText('No purchasing needed').first().waitFor()
  await submit(page, 'Confirm').click()
  await expect(row(page, 'materials')).toContainText('Not required')
  await tab(page, 'Production')
  await row(page, 'preparation').getByRole('button', { name: 'Mark not required' }).click()
  await expect(row(page, 'preparation')).toContainText('Not required')
  for (const key of ['quote', 'artwork', 'materials', 'preparation']) await expect(row(page, key), key).not.toContainText('Pending')

  // 10: with only the PO unapproved, production cannot start: no Start on the order, and the server refuses it at the authorization gate
  await expect(row(page, 'authorization')).toContainText('Pending')
  await expect(btn(page, 'Start', n)).toHaveCount(0)
  await expect(page.getByText('Not ready for production')).toBeVisible()
  const before = await detail(page, n)
  const refused = await page.request.patch(`/api/app/orders/${n}/production`, { data: { to: 'in_production', expectedVersion: before.order.version } })
  expect(refused.status()).toBe(409)
  expect((await refused.json()).code).toBe('transition_not_allowed') // from an awaiting status a start is not even a legal move
  // Asking for "ready" is where the gate itself answers: it names the one pending item, the PO.
  const gated = await page.request.patch(`/api/app/orders/${n}/production`, { data: { to: 'ready', expectedVersion: before.order.version } })
  expect(gated.status()).toBe(409)
  const refusal = await gated.json()
  expect(refusal.code).toBe('gate_failed')
  expect(refusal.reasons).toEqual(['authorization.po_not_approved'])
  expect((await detail(page, n)).order.productionStatus).not.toBe('in_production')
  // 17: while it waits on the PO, the order is under "Pending POs" in Action required
  // (the card lists only the first three rows, so the specific order is read from the same data the card renders)
  await page.goto('/app')
  await expect(page.getByRole('group', { name: 'Pending POs' })).toBeVisible()
  const dash = (await (await page.request.get('/api/app/dashboard')).json()) as { actionRequired: { pendingPos: { number: string }[] } }
  expect(dash.actionRequired.pendingPos.map((r) => r.number)).toContain(n)
  await page.goto(`/app/orders/${n}`)
  await tab(page, 'Production')

  // 6: approve the PO from the gate banner; Start is now offered, and the order is ready for production
  await page.getByRole('button', { name: 'Record approval' }).click()
  await expect(row(page, 'authorization')).toContainText('Complete')
  await expect(productionChip(page)).toContainText('Ready for production')
  await expect(btn(page, 'Start', n)).toBeVisible()

  // 9, 11: start, units, QC, complete
  await runProduction(page, n, 4)
  await expectPendingOnDashboard(page, n, 4800) // 17

  // 12, 13, 15: pickup before payment is allowed for a district, without an override
  await page.goto(`/app/orders/${n}`)
  await tab(page, 'Pickup')
  await btn(page, 'Record pickup', n).click()
  await dialog(page).getByLabel('Collected by').fill('Coach Lee')
  await expect(dialog(page).getByRole('alert').filter({ hasText: 'still owes' })).toHaveCount(0)
  await expect(dialog(page).getByRole('button', { name: /override/i })).toHaveCount(0)
  await submit(page, 'Record pickup').click()
  await expect(page.getByText(/Picked up by Coach Lee/)).toBeVisible()
  await expect(page.getByText(/Released before payment/)).toHaveCount(0)
  expect((await detail(page, n)).order.state).toBe('active')
  // 15: the balance is outstanding on the Payments page
  await page.goto('/app/payments')
  await expect(page.getByRole('region', { name: 'Outstanding', exact: true }).locator(`[data-order="${n}"]`)).toContainText('$48.00')

  // 15, 16: a new check collection, ready, collected (balance 0, one payment), deposited, cleared
  await page.goto(`/app/orders/${n}`)
  await tab(page, 'Payments')
  await page.getByRole('button', { name: 'New check collection', exact: true }).click()
  await submit(page, 'New check collection').click()
  const check = page.getByRole('list', { name: 'Checks' }).getByRole('listitem')
  await expect(check.getByText('Awaiting payment')).toBeVisible()
  await check.getByRole('button', { name: /^Mark ready:/ }).click()
  await expect(check.getByText('Ready for collection')).toBeVisible()
  await check.getByRole('button', { name: /^Record collection:/ }).click()
  await dialog(page).getByLabel('Check number (optional)').fill('7788')
  await submit(page, 'Record collection').click()
  await expect(check.getByText('Collected', { exact: true }).first()).toBeVisible()
  let p = await paymentsOf(page, n)
  expect(p.payments).toHaveLength(1)
  expect(p.balance).toMatchObject({ receivedCents: 4800, outstandingCents: 0 })
  await expect.poll(async () => (await detail(page, n)).order.state).toBe('closed') // picked up + paid

  await check.getByRole('button', { name: /^Mark deposited:/ }).click()
  await expect(check.getByText('Deposited', { exact: true }).first()).toBeVisible()
  await check.getByRole('button', { name: /^Mark cleared:/ }).click()
  await expect(check.getByText('Cleared', { exact: true }).first()).toBeVisible()
  p = await paymentsOf(page, n)
  expect(p.payments).toHaveLength(1)
  expect(p.balance).toMatchObject({ receivedCents: 4800, outstandingCents: 0 }) // clearing changes no balance
  expect(p.checks[0].status).toBe('cleared')
  expect((await detail(page, n)).order.state).toBe('closed')

  // 17: the order is no longer pending anywhere on the dashboard
  await page.goto('/app')
  await expect(page.getByRole('region', { name: 'Ready for pickup', exact: true }).locator(`[data-ready="${n}"]`)).toHaveCount(0)
  expect((await outstandingRows(page)).some((r) => r.number === n)).toBe(false)

  await activityHas(page, n, [
    'Order created', 'Purchase order added on {n}', 'Purchase order document uploaded on {n}', 'Artwork decision recorded on {n}', 'No purchasing needed confirmed on {n}',
    'Production started on {n}', 'Order {n} picked up', 'Check collection added on {n}', 'Check collected on {n}', 'Check deposited on {n}', 'Check cleared on {n}', 'Order {n} closed: picked up and paid',
  ])
})
