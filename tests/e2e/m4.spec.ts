import { expect, test, type Page } from '@playwright/test'
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

test.skip('staff do not see the override button', () => {
  // Skipped: the e2e server authenticates one fixed user (DEV_AUTH_EMAIL=owner1@example.com, an owner), so a staff session
  // cannot be simulated here. The server refuses a staff override with 403 override_requires_owner (tests/api); the UI only
  // offers it when GET /api/app/me says role = owner (ProductionControls.tsx, canOverride).
})
