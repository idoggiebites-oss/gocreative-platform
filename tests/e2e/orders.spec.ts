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

const ORDER_LINK = /^\d{4}-\d{4}$/
type ListRows = { rows: { number: string }[] }

test('orders list switches views and searching narrows the rows', async ({ page }, info) => {
  // Pick one order that is waiting on a PO and one that is not, from the API, never hard-coded.
  const api = async (view: string) => ((await (await page.request.get(`/api/app/orders?view=${view}&limit=200`)).json()) as ListRows).rows.map((r) => r.number)
  const waiting = await api('waiting_po')
  const active = await api('active')
  const eligible = waiting[0]!
  const ineligible = active.find((n) => !waiting.includes(n))!
  expect(eligible).toBeTruthy()
  expect(ineligible).toBeTruthy()

  await page.goto('/app/orders')
  const rows = page.getByRole('link', { name: ORDER_LINK }) // one per visible row, in either layout
  await expect(rows.first()).toBeVisible()
  expect(await rows.count()).toBeGreaterThan(1)
  await expect(page.getByRole('link', { name: ineligible, exact: true })).toBeVisible()

  const views = page.getByRole('navigation', { name: 'Order views' })
  await views.getByRole('link', { name: /^Waiting on PO/ }).click()
  await expect(page).toHaveURL(/view=waiting_po/)
  await expect(views.getByRole('link', { name: /^Waiting on PO/ })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('link', { name: eligible, exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: ineligible, exact: true })).toHaveCount(0)
  await expect(rows).toHaveCount(waiting.length)
  await views.getByRole('link', { name: /^Active/ }).click()
  await expect(page).not.toHaveURL(/view=/)
  await expect(page.getByRole('link', { name: ineligible, exact: true })).toBeVisible()

  await page.getByRole('searchbox', { name: 'Filter orders' }).fill(GATED)
  await expect(page).toHaveURL(new RegExp(`q=${GATED}`))
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveText(GATED)

  // view and q survive a reload
  await page.reload()
  await expect(page.getByRole('searchbox', { name: 'Filter orders' })).toHaveValue(GATED)
  await expect(rows).toHaveCount(1)

  // the whole row navigates
  if (info.project.name === 'desktop') await page.locator('tbody tr').first().getByRole('cell').nth(5).click()
  else await page.locator('li').filter({ has: rows.first() }).click({ position: { x: 150, y: 10 } })
  await expect(page).toHaveURL(new RegExp(`/app/orders/${GATED}$`))
})

test('refetch failure keeps the cached data and shows an announced notice with Retry', async ({ page }) => {
  await page.goto('/app')
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible()
  await page.route('**/api/app/dashboard', (r) => r.fulfill({ status: 500, json: { error: 'boom' } }))
  await page.evaluate("window.dispatchEvent(new Event('visibilitychange'))") // triggers a refetch on "focus"
  const notice = page.getByRole('status').filter({ hasText: 'Could not refresh' })
  await expect(notice).toBeVisible()
  await expect(notice).toHaveAttribute('aria-live', 'polite')
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible() // cached data still there
  await page.unroute('**/api/app/dashboard')
  await notice.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText('Could not refresh')).toHaveCount(0)
})

test('desktop: a refused change is shown in Spanish, never as the server English', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  await page.route('**/purchase-orders/*', (r) => r.fulfill({ status: 409, json: { error: 'Invalid PO transition: received to approved', code: 'po_transition_not_allowed' } }))
  await page.goto(`/app/orders/${GATED}`)
  await page.getByRole('button', { name: 'Español' }).click()
  await page.getByRole('button', { name: /^Orden de compra: Recibida/ }).click()
  await page.getByRole('menuitem').first().click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('No se aplicó ese cambio.')
  await expect(alert).toContainText('Ese cambio de estado de la orden de compra no está permitido.')
  await expect(alert).not.toContainText('Invalid')
})

test('desktop: after a keyboard status change focus returns to the status control', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  try {
    await page.route('**/purchase-orders/*', async (r) => { await new Promise((ok) => setTimeout(ok, 800)); await r.continue() }) // keep it saving for a while
    await page.goto(`/app/orders/${GATED}`)
    const saving = page.getByRole('button', { name: /^Purchase order: Received/ })
    await saving.focus()
    await page.keyboard.press('Enter') // opens the menu on the first item
    await page.keyboard.press('Enter') // picks it
    // While saving the control is busy but never disabled: a disabled element cannot keep keyboard focus.
    await expect(saving).toHaveAttribute('aria-busy', 'true')
    await expect(saving).toBeEnabled()
    const trigger = page.getByRole('button', { name: /^Purchase order: Under review/ })
    await expect(trigger).toBeVisible() // the save has settled and the control re-rendered
    await expect(trigger).toBeFocused()
    expect(await page.evaluate("document.activeElement?.getAttribute('aria-label')")).toMatch(/^Purchase order: Under review/)
  } finally {
    reseed() // this test changed the PO
  }
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
  await expect(page.locator('table').getByText('Esperando autorización').first()).toBeVisible()
  await expect(page.locator('table').getByText('Aprobado', { exact: true }).first()).toBeVisible()
  await page.goto('/app/orders/2026-0010') // still gated whatever the approval test did to GATED
  await expect(page.getByText('La producción está bloqueada.')).toBeVisible()
})

test('unknown order shows a not-found state with a way back', async ({ page }) => {
  await page.goto('/app/orders/2099-9999')
  await expect(page.getByRole('heading', { name: 'Order not found' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to orders' }).click()
  await expect(page).toHaveURL(/\/app\/orders$/)
})

test('phone: pages fit, rows show their chips and dates, and the detail controls are reachable', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone')
  const fits = async (path: string) => {
    const scroll = (await page.evaluate('document.documentElement.scrollWidth')) as number
    const width = (await page.evaluate('window.innerWidth')) as number
    expect(scroll, path).toBeLessThanOrEqual(width)
  }

  // dashboard: stacked rows, reason chip visible, no table
  await page.goto('/app')
  const attention = page.getByRole('region', { name: 'Needs attention' })
  await expect(attention.locator('table')).toBeHidden()
  const attRow = attention.locator('li').first()
  await expect(attRow.getByRole('link', { name: ORDER_LINK })).toBeVisible()
  await expect(attRow.getByText(/^Overdue/)).toBeVisible() // the seed's most severe reason
  await expect(attRow.locator('span.num').last()).toBeVisible() // due date
  await fits('/app')

  // orders list: production chip and due date of the first row (taken from the API)
  const first = (((await (await page.request.get('/api/app/orders?limit=1')).json()) as { rows: { number: string; productionStatus: string }[] }).rows)[0]!
  await page.goto('/app/orders')
  await expect(page.locator('table').first()).toBeHidden()
  const row = page.locator('li').filter({ has: page.getByRole('link', { name: first.number, exact: true }) })
  await expect(row.getByText(new RegExp(first.productionStatus.replace(/_/g, ' '), 'i'))).toBeVisible()
  await expect(row.locator('span.num').last()).toHaveText(/\S/)
  await expect(row.locator('span.num').last()).toBeVisible()
  await fits('/app/orders')

  // detail: the later tabs and the PO control can be reached
  await page.goto(`/app/orders/${GATED}`)
  const po = page.getByRole('button', { name: /^Purchase order:/ })
  await po.scrollIntoViewIfNeeded()
  await expect(po).toBeInViewport()
  const activity = page.getByRole('tab', { name: 'Activity' })
  await activity.scrollIntoViewIfNeeded()
  await activity.click()
  await expect(activity).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel').getByText('Order created')).toBeVisible()
  await fits(`/app/orders/${GATED}`)
})
