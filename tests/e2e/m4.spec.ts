import { expect, test, type Locator, type Page } from '@playwright/test'
import { makeOrder } from './helpers.ts'
import { reseed } from './prepare.ts'

// M4: the Production page, the dashboard's production and action-required sections, and the order's Production tab.
// Orders are made over the API so nothing depends on the seed. The shop runs one job at a time, so every test first
// sends whatever is running (from other specs) to quality control, which frees the slot.
test.afterAll(() => {
  reseed()
})

const dialog = (page: Page) => page.getByRole('dialog')
const fits = async (page: Page) => {
  const scroll = (await page.evaluate('document.documentElement.scrollWidth')) as number
  const width = (await page.evaluate('window.innerWidth')) as number
  expect(scroll).toBeLessThanOrEqual(width)
}
const setLang = (page: Page, lang: 'en' | 'es') => page.evaluate((l) => localStorage.setItem('lang', l), lang)

type Job = { number: string; version: number }
const production = async (page: Page) => (await (await page.request.get('/api/app/production')).json()) as { current: Job[]; readyToStart: Job[]; completed: Job[] }

async function clearRunning(page: Page) {
  for (const j of (await production(page)).current) {
    const res = await page.request.patch(`/api/app/orders/${j.number}/production`, { data: { to: 'quality_control', expectedVersion: j.version } })
    expect(res.ok(), await res.text()).toBe(true)
  }
}

/** An order that passes the five-item gate (accepted quote, authorization, no artwork, no purchasing, prep not required), over the API. */
async function readyOrder(page: Page, title: string, extra: object = {}, quantity = 2) {
  const o = await makeOrder(page, title, [{ kind: 'product', product: 'Tee', method: 'screen', quantity, unitPriceCents: 1000 }], extra)
  let version = o.version
  const step = async (method: 'post' | 'patch', path: string, data: object) => {
    const res = await page.request[method](`/api/app/orders/${o.number}${path}`, { data: { ...data, expectedVersion: version } })
    expect(res.ok(), await res.text()).toBe(true)
    version = (await res.json()).version
  }
  await step('post', '/quotes', {})
  await step('patch', '/quotes/1', { to: 'accepted' })
  await step('post', '/authorization', { method: 'phone' })
  await step('patch', '', { artworkRequired: false, materialsRequired: false, confirmNoPurchasing: true })
  await step('patch', '/prep', { prepStatus: 'not_required' })
  await expect.poll(async () => (await production(page)).readyToStart.some((j) => j.number === o.number)).toBe(true)
  return o.number
}

const startViaApi = async (page: Page, number: string) => {
  const job = (await production(page)).readyToStart.find((j) => j.number === number)!
  const res = await page.request.patch(`/api/app/orders/${number}/production`, { data: { to: 'in_production', expectedVersion: job.version } })
  expect(res.ok(), await res.text()).toBe(true)
}

const current = (page: Page) => page.getByRole('region', { name: 'Currently in production' })
const readySection = (page: Page) => page.getByRole('region', { name: 'Ready to start' })
const completedSection = (page: Page) => page.getByRole('region', { name: 'Completed production' })
const btn = (page: Page, action: string, n: string) => page.getByRole('button', { name: `${action}: ${n}`, exact: true })

test('start, refuse a second start by name, owner override, units, QC and complete', async ({ page }) => {
  await clearRunning(page)
  const [a, b, c] = [await readyOrder(page, 'Job A'), await readyOrder(page, 'Job B'), await readyOrder(page, 'Job C')]
  await page.goto('/app/production')

  await btn(page, 'Start', a).click()
  await expect(current(page)).toContainText(a)
  await expect(current(page).getByText('1 active job')).toBeVisible()
  // It is the current job on the dashboard too.
  await page.goto('/app')
  await expect(page.getByRole('region', { name: 'Current production job' })).toContainText(a)
  await page.goto('/app/production')

  // A second start is refused and names the running order.
  await btn(page, 'Start', b).click()
  await expect(readySection(page).getByRole('alert')).toContainText(`Order ${a} is already in production`)
  await expect(readySection(page)).toContainText(b)

  // The owner can override, but only with a reason.
  await btn(page, 'Start anyway (override)', b).click()
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: 'Start anyway', exact: true })).toBeDisabled()
  await dialog(page).getByLabel('Reason').fill('Rush for the game on Friday')
  await dialog(page).getByRole('button', { name: 'Start anyway', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(current(page).getByText('2 active jobs')).toBeVisible()
  await expect(current(page)).toContainText('Owner override')
  await expect(current(page)).toContainText('Rush for the game on Friday')
  await expect(current(page)).toContainText('Owner One')

  // With both slots taken there is no override, and a start is refused.
  await expect(btn(page, 'Start anyway (override)', c)).toHaveCount(0)
  await btn(page, 'Start', c).click()
  await expect(readySection(page).getByRole('alert')).toContainText('Two jobs are already in production')

  // Units completed: a valid count saves, an out-of-range one is refused and the old value stays.
  const units = page.getByLabel(`Units completed (number): ${a}`)
  await units.fill('1')
  await page.getByRole('button', { name: 'Save units' }).first().click()
  await expect(current(page).getByText('1 of 2').first()).toBeVisible()
  await units.fill('99')
  await page.getByRole('button', { name: 'Save units' }).first().click()
  await expect(current(page).getByRole('alert')).toContainText('between 0 and the order’s total quantity')
  await expect(current(page).getByText('1 of 2').first()).toBeVisible()

  // Quality control, then complete.
  await btn(page, 'Send to quality control', a).click()
  await expect(completedSection(page)).toContainText(a)
  await expect(completedSection(page).getByRole('listitem').filter({ hasText: a })).toContainText('Quality control')
  await btn(page, 'Mark production complete', a).click()
  await expect(completedSection(page).getByRole('listitem').filter({ hasText: a })).toContainText('Production complete')
  await expect(current(page)).not.toContainText(a)

  // The dashboard now shows the override job.
  await page.goto('/app')
  await expect(page.getByRole('region', { name: 'Current production job' })).toContainText(b)
  await clearRunning(page)
})

test('restart from quality control, and pause returns the job to Ready to start', async ({ page }) => {
  await clearRunning(page)
  const a = await readyOrder(page, 'Restart job')
  await startViaApi(page, a)
  await page.goto('/app/production')
  await btn(page, 'Send to quality control', a).click()
  await expect(completedSection(page)).toContainText(a)
  await btn(page, 'Restart from quality control', a).click()
  await expect(current(page)).toContainText(a)
  await expect(completedSection(page).getByRole('listitem').filter({ hasText: a })).toHaveCount(0)

  await btn(page, 'Pause', a).click()
  await expect(readySection(page)).toContainText(a)
  await expect(current(page)).not.toContainText(a)
  await expect(page.getByText('Nothing is in production right now.').first()).toBeVisible()
})

test('the order’s Production tab uses the same controls', async ({ page }) => {
  await clearRunning(page)
  const a = await readyOrder(page, 'Tab job')
  await page.goto(`/app/orders/${a}`)
  await page.getByRole('tab', { name: 'Production' }).click()
  await btn(page, 'Start', a).click()
  await expect(page.getByRole('group', { name: 'Production' }).first()).toContainText('In production')
  await page.getByLabel(`Units completed (number): ${a}`).fill('2')
  await page.getByRole('button', { name: 'Save units' }).click()
  await expect(page.getByText('2 of 2')).toBeVisible()
  await btn(page, 'Send to quality control', a).click()
  await expect(btn(page, 'Mark production complete', a)).toBeVisible()
  await btn(page, 'Mark production complete', a).click()
  await expect(page.getByRole('group', { name: 'Production' }).first()).toContainText('Production complete')
})

test('reorder the queue with the move buttons; a stale queue says it was reloaded', async ({ page }) => {
  const x = await readyOrder(page, 'Queue X')
  const y = await readyOrder(page, 'Queue Y')
  const pos = async (p: Page, n: string) => (await readySection(p).getByRole('listitem').allInnerTexts()).findIndex((t) => t.includes(n))
  const before = async (p: Page, first: string, second: string) => (await pos(p, first)) < (await pos(p, second))
  await page.goto('/app/production')
  await expect(readySection(page)).toContainText(y)
  const startX = await pos(page, x)
  expect(startX).toBeGreaterThanOrEqual(0)
  expect(await pos(page, y)).toBeGreaterThan(startX)

  await btn(page, 'Move up', y).click()
  await expect.poll(() => before(page, y, x)).toBe(true)

  // A second page moves X up first; the first page still shows the old order, so its next move is refused.
  const other = await page.context().newPage()
  await other.goto('/app/production')
  await expect(readySection(other)).toContainText(x)
  await btn(other, 'Move up', x).click()
  await expect.poll(() => before(other, x, y)).toBe(true)

  await btn(page, 'Move down', y).click()
  await expect(readySection(page).getByRole('alert')).toContainText('The queue changed while you were looking at it')
  // The reloaded queue is the other page's order.
  await expect.poll(() => before(page, x, y)).toBe(true)
  await other.close()
})

test('the dashboard lists an order missing artwork under Action required and links to it', async ({ page }) => {
  // Due long ago so it sorts first in its group, which shows only the first few rows.
  const o = await makeOrder(page, 'Needs art', undefined, { dueDate: '2020-01-01' })
  await page.goto('/app')
  const group = page.getByRole('group', { name: 'Missing artwork' })
  const link = group.getByRole('link', { name: new RegExp(o.number) })
  await expect(link).toBeVisible()
  // The M5 groups have no rows yet, so they are not rendered at all.
  await expect(page.getByText('Awaiting pickup', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Checks to collect', { exact: true })).toHaveCount(0)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/app/orders/${o.number}$`))
})

test('production page and dashboard fit the screen width', async ({ page }) => {
  await clearRunning(page)
  const a = await readyOrder(page, 'Fit A')
  await readyOrder(page, 'Fit B')
  await startViaApi(page, a)
  for (const path of ['/app/production', '/app']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: /Production|Good/ }).first()).toBeVisible()
    await fits(page)
  }
  await clearRunning(page)
})

test('Spanish: the page, the buttons and the override dialog', async ({ page }) => {
  await clearRunning(page)
  const a = await readyOrder(page, 'Spanish A')
  const b = await readyOrder(page, 'Spanish B')
  await startViaApi(page, a)
  await page.goto('/app/production')
  await setLang(page, 'es')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'En producción ahora' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Listos para empezar' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Producción terminada' })).toBeVisible()
  await expect(page.getByText('1 trabajo activo')).toBeVisible()
  await expect(btn(page, 'Enviar a control de calidad', a)).toBeVisible()
  await expect(page.getByText('Unidades terminadas').first()).toBeVisible()
  await btn(page, 'Empezar', b).click()
  await expect(page.getByRole('alert').filter({ hasText: 'ya está en producción' })).toContainText(a)

  const opener = btn(page, 'Empezar de todos modos (excepción)', b)
  await opener.click()
  await expect(dialog(page).getByRole('heading', { name: `Empezar ${b} junto al trabajo en curso` })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(opener).toBeFocused()

  await page.goto('/app')
  await expect(page.getByRole('heading', { name: 'Trabajo actual en producción' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Próxima producción' })).toBeVisible()
  await setLang(page, 'en')
  await clearRunning(page)
})

const refetch = (page: Page) => page.evaluate("window.dispatchEvent(new Event('visibilitychange'))")
const jobOf = async (page: Page, n: string) => {
  const d = await production(page)
  return [...d.current, ...d.readyToStart, ...d.completed].find((j) => j.number === n) as Job & { unitsCompleted: number; preProductionStatus: string; productionStatus: string }
}
/** Scrolled into view, the whole box inside the 390px screen. */
const inView = async (loc: Locator) => {
  await loc.scrollIntoViewIfNeeded()
  await expect(loc).toBeVisible()
  const box = (await loc.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
}

test('staff are not offered the override', async ({ page }) => {
  // The e2e server signs in one fixed owner, so the role the page reads is faked; the server's own 403 is in tests/api.
  await page.route('**/api/app/me', (r) => r.fulfill({ json: { id: 2, email: 'staff@example.com', name: 'Staff', role: 'staff' } }))
  await clearRunning(page)
  const a = await readyOrder(page, 'Staff A')
  const b = await readyOrder(page, 'Staff B')
  await startViaApi(page, a)
  const me = page.waitForResponse('**/api/app/me')
  await page.goto('/app/production')
  await me
  await expect(btn(page, 'Start', b)).toBeVisible()
  await expect(btn(page, 'Start anyway (override)', b)).toHaveCount(0)
  await clearRunning(page)
})

test('a units draft keeps its typing across a refetch, then a conflict loads the fresh count and nothing stale is stored', async ({ browser, page }, info) => {
  test.skip(info.project.name !== 'desktop')
  await clearRunning(page)
  const a = await readyOrder(page, 'Units conflict', {}, 20)
  await startViaApi(page, a)
  await page.goto('/app/production')
  const input = page.getByLabel(`Units completed (number): ${a}`)
  await input.fill('7')

  // Another person saves a different count.
  const other = await (await browser.newContext({ baseURL: 'http://localhost:4280' })).newPage()
  const job = await jobOf(other, a)
  const res = await other.request.patch(`/api/app/orders/${a}/units`, { data: { unitsCompleted: 5, expectedVersion: job.version } })
  expect(res.ok(), await res.text()).toBe(true)

  await refetch(page)
  await expect(current(page).getByText('5 of 20').first()).toBeVisible()
  await expect(input).toHaveValue('7') // the typing survived, and still carries the old version

  await page.getByRole('button', { name: 'Save units' }).first().click()
  await expect(current(page).getByRole('status').filter({ hasText: 'Someone else changed this while you were editing' })).toBeVisible()
  await expect(input).toHaveValue('5')
  await expect(current(page).getByText('5 of 20').first()).toBeVisible()
  expect((await jobOf(page, a)).unitsCompleted).toBe(5) // A's 7 was never stored

  await input.fill('9')
  await page.getByRole('button', { name: 'Save units' }).first().click()
  await expect(current(page).getByText('9 of 20').first()).toBeVisible()
  expect((await jobOf(page, a)).unitsCompleted).toBe(9)
  await other.context().close()
  await clearRunning(page)
})

test('the override dialog sends the version it opened at: a change behind it is a translated conflict and nothing starts', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  await clearRunning(page)
  const a = await readyOrder(page, 'Override base')
  const b = await readyOrder(page, 'Override target')
  await startViaApi(page, a)
  await page.goto('/app/production')
  await btn(page, 'Start anyway (override)', b).click()
  await dialog(page).getByLabel('Reason').fill('Rush')

  const seen = await jobOf(page, b)
  const res = await page.request.patch(`/api/app/orders/${b}`, { data: { title: 'Changed behind the dialog', expectedVersion: seen.version } })
  expect(res.ok(), await res.text()).toBe(true)

  await dialog(page).getByRole('button', { name: 'Start anyway', exact: true }).click()
  await expect(dialog(page).getByRole('status')).toContainText('Someone else changed this while you were editing')
  const now = await production(page)
  expect(now.current.map((j) => j.number)).toEqual([a]) // b was not started
  expect(now.readyToStart.map((j) => j.number)).toContain(b)
  await page.keyboard.press('Escape')
  await clearRunning(page)
})

test('Pause after readiness changed behind the page is refused with a translated 409, then pauses to what readiness says now', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop')
  await clearRunning(page)
  const a = await readyOrder(page, 'Pause drift')
  await startViaApi(page, a)
  await page.goto('/app/production')
  await expect(btn(page, 'Pause', a)).toBeVisible()

  const seen = await jobOf(page, a)
  const res = await page.request.delete(`/api/app/orders/${a}/authorization`, { data: { reason: 'Customer withdrew', expectedVersion: seen.version } })
  expect(res.ok(), await res.text()).toBe(true)

  await btn(page, 'Pause', a).click() // still carries 'ready' and the old version
  await expect(current(page).getByRole('alert')).toContainText('That change was not applied')
  await expect(current(page)).toContainText(a) // nothing moved
  await expect.poll(async () => (await jobOf(page, a)).preProductionStatus).toBe('awaiting_authorization')

  await btn(page, 'Pause', a).click() // the refreshed row sends the refreshed target
  await expect(current(page)).not.toContainText(a)
  const detail = await (await page.request.get(`/api/app/orders/${a}`)).json()
  expect(detail.readiness.preProductionStatus).toBe('awaiting_authorization')
  expect(detail.order.productionStatus).toBe(detail.readiness.preProductionStatus)
})

test('phone: the override dialog, the order’s Production tab and the Spanish controls fit 390px with a long name', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone')
  await clearRunning(page)
  const long = 'Camisetas del equipo de fútbol del distrito escolar independiente de Cedar Hollow temporada de primavera'
  const a = await readyOrder(page, long)
  const b = await readyOrder(page, long)
  await startViaApi(page, a)

  const checkAll = async (lang: 'en' | 'es') => {
    const t = lang === 'en'
      ? { override: 'Start anyway (override)', submit: 'Start anyway', tab: 'Production', qc: 'Send to quality control', pause: 'Pause', save: 'Save units' }
      : { override: 'Empezar de todos modos (excepción)', submit: 'Empezar de todos modos', tab: 'Producción', qc: 'Enviar a control de calidad', pause: 'Pausar', save: 'Guardar unidades' }
    await page.goto('/app/production')
    await setLang(page, lang)
    await page.reload()
    await fits(page)
    await btn(page, t.override, b).scrollIntoViewIfNeeded()
    await btn(page, t.override, b).click()
    await expect(dialog(page)).toBeVisible()
    await fits(page)
    await inView(dialog(page).getByRole('button', { name: t.submit, exact: true }))
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)

    await page.goto(`/app/orders/${a}`)
    await page.getByRole('tab', { name: t.tab }).click()
    await fits(page)
    await inView(btn(page, t.qc, a))
    await inView(btn(page, t.pause, a))
    await inView(page.getByRole('button', { name: t.save }))
    await fits(page)
  }
  await checkAll('en')
  await checkAll('es')
  await setLang(page, 'en')
  await clearRunning(page)
})
