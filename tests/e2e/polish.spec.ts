import { expect, test, type Page } from '@playwright/test'
import { clearRunning, makeOrder, production, readyOrder } from './helpers.ts'
import { reseed } from './prepare.ts'

// M6 polish: the Phase 1 carry-overs (Spanish column overflow, focus after a button disappears) and the Phase 2 accessibility pass.
test.afterAll(() => {
  reseed()
})

const dialog = (page: Page) => page.getByRole('dialog')
// Where focus goes when the pressed button disappears: the first usable control in its parent (the PO status menu, the next action).
const AFTER_APPROVE = 'Purchase order: Approved. Change status'
const row = (page: Page, key: string) => page.locator(`[data-readiness="${key}"]`)
const desktopOnly = (info: { project: { name: string } }) => test.skip(info.project.name === 'phone')
const btn = (page: Page, action: string, n: string) => page.getByRole('button', { name: `${action}: ${n}`, exact: true })
// In-page code is passed as source strings: the e2e files are type-checked without the DOM lib.
const inPage = <T>(page: Page, src: string) => page.evaluate(`(() => { ${src} })()`) as Promise<T>
const focusedLabel = (page: Page) => inPage<string | null>(page, `
  const a = document.activeElement
  return a && a !== document.body ? (a.getAttribute('aria-label') ?? a.textContent ?? a.tagName).trim() : null`)

test('Spanish at 1440px: the orders table and the Payments page table fit their cards (no inner scroll)', async ({ page }, info) => {
  desktopOnly(info)
  await page.goto('/app')
  await page.evaluate("localStorage.setItem('lang', 'es')")
  const scrolls = () => inPage<string[]>(page, `
    return Array.from(document.querySelectorAll('section, div')).filter((h) => h.clientWidth > 5 && h.scrollWidth > h.clientWidth + 1 && getComputedStyle(h).overflowX !== 'visible').map((h) => h.scrollWidth + '/' + h.clientWidth)`)
  for (const path of ['/app/orders', '/app/orders?view=waiting_po', '/app/payments']) {
    await page.goto(path)
    await expect(page.locator('table:visible').first()).toBeVisible()
    expect(await scrolls(), path).toEqual([])
  }
})

test('focus after "Record approval" lands on a real element, not the page body', async ({ page }, info) => {
  desktopOnly(info)
  const o = await makeOrder(page, 'Focus approval', undefined, { poRequired: true })
  let version = o.version
  const res = await page.request.post(`/api/app/orders/${o.number}/purchase-orders`, { data: { poNumber: 'PO-F1', expectedVersion: version } })
  expect(res.ok(), await res.text()).toBe(true)
  version = (await res.json()).version
  const poId = (await (await page.request.get(`/api/app/orders/${o.number}/purchase-orders`)).json()).purchaseOrders[0].id
  for (const to of ['received', 'under_review']) {
    const r = await page.request.patch(`/api/app/orders/${o.number}/purchase-orders/${poId}`, { data: { to, expectedVersion: version } })
    expect(r.ok(), await r.text()).toBe(true)
    version = (await r.json()).version
  }
  await page.goto(`/app/orders/${o.number}`)
  const approve = page.getByRole('button', { name: 'Record approval' })
  await approve.focus()
  await page.keyboard.press('Enter')
  await expect(approve).toHaveCount(0)
  // Which neighbour takes focus depends on which refetch lands first under load; both are real controls in the same panel. Never the body.
  await expect.poll(() => focusedLabel(page)).toMatch(new RegExp(`^(${AFTER_APPROVE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|View purchase order)$`))
})

test('focus follows a production-tab button that turns into another one', async ({ page }, info) => {
  desktopOnly(info)
  await clearRunning(page)
  const n = await readyOrder(page, 'Focus production')
  await page.goto(`/app/orders/${n}`)
  await page.getByRole('tab', { name: 'Production', exact: true }).click()
  const start = btn(page, 'Start', n)
  await start.focus()
  await page.keyboard.press('Enter')
  await expect(start).toHaveCount(0)
  await expect.poll(() => focusedLabel(page)).toBe(`Send to quality control: ${n}`)
  await btn(page, 'Send to quality control', n).focus()
  await page.keyboard.press('Enter')
  await expect(btn(page, 'Mark production complete', n)).toBeVisible()
  await expect.poll(() => focusedLabel(page)).toBe(`Restart from quality control: ${n}`)
  await clearRunning(page)
})

test('keyboard: Production page controls are reachable by Tab and named; move up/down work; the override dialog is labelled, traps Tab and returns focus', async ({ page }, info) => {
  desktopOnly(info)
  await clearRunning(page)
  const first = await readyOrder(page, 'Kbd first')
  const second = await readyOrder(page, 'Kbd second')
  const running = await readyOrder(page, 'Kbd running')
  await page.goto('/app/production')
  // Tab from the top of the page through every control: each focus stop has an accessible name.
  await page.locator('h1').focus() // a heading is not focusable; start from the body and tab
  await page.evaluate('document.activeElement && document.activeElement.blur()')
  const seen: string[] = []
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press('Tab')
    const label = await inPage<string | null>(page, `
      const a = document.activeElement
      if (!a || a === document.body) return null
      const lb = a.getAttribute('aria-labelledby')
      const labels = a.labels
      return (lb ? document.getElementById(lb)?.textContent : null) ?? a.getAttribute('aria-label') ?? (labels?.length ? labels[0].textContent : null) ?? a.textContent`)
    if (label === null) break
    expect(label.trim(), `focus stop ${i}`).not.toBe('')
    seen.push(label.trim())
    if (seen.includes(`Move down: ${second}`) && seen.includes(`Start: ${second}`)) break
  }
  for (const want of [`Move up: ${second}`, `Move down: ${first}`, `Start: ${first}`]) expect(seen).toContain(want)

  // Move down, by keyboard only.
  const order = async () => (await page.getByRole('region', { name: 'Ready to start' }).getByRole('listitem').allInnerTexts()).map((t) => [first, second].find((n) => t.includes(n)) ?? '').filter(Boolean)
  expect((await order()).indexOf(first)).toBeLessThan((await order()).indexOf(second))
  await btn(page, 'Move down', first).focus()
  await page.keyboard.press('Space')
  await expect.poll(async () => (await order()).indexOf(second) < (await order()).indexOf(first)).toBe(true)
  // The button just used is now disabled (the job reached the end of the queue, or stayed with a move down left): focus goes to
  // that job's other move button when this one is disabled, else it stays on the same one.
  const queue = (await production(page)).readyToStart.map((j) => j.number)
  await expect.poll(() => focusedLabel(page)).toBe(queue.indexOf(first) === queue.length - 1 ? `Move up: ${first}` : `Move down: ${first}`)

  // The override dialog: needs a running job in slot 1 and an owner (the e2e user).
  const job = (await (await page.request.get('/api/app/production')).json()).readyToStart.find((j: { number: string }) => j.number === running)
  expect((await page.request.patch(`/api/app/orders/${running}/production`, { data: { to: 'in_production', expectedVersion: job.version } })).ok()).toBe(true)
  await page.reload()
  const opener = btn(page, 'Start anyway (override)', first)
  await opener.focus()
  await page.keyboard.press('Enter')
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page)).toHaveAccessibleName(`Start ${first} alongside the running job`)
  await expect(dialog(page)).toHaveAccessibleDescription(/.+/)
  const inside = () => inPage<boolean>(page, `return !!document.activeElement?.closest('[role=dialog]')`)
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    expect(await inside(), `Tab ${i} stays in the dialog`).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(opener).toBeFocused()
  await clearRunning(page)
})

test('headings never skip a level and every page has one h1 (Phase 2 screens)', async ({ page }, info) => {
  desktopOnly(info)
  const check = async (path: string, tabs: string[] = []) => {
    await page.goto(path)
    await expect(page.locator('h1')).toHaveCount(1)
    for (const t of [null, ...tabs]) {
      if (t) await page.getByRole('tab', { name: t, exact: true }).click()
      const levels = await inPage<number[]>(page, `return Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter((h) => h.offsetParent !== null).map((h) => Number(h.tagName[1]))`)
      let prev = 0
      for (const l of levels) { expect(l - prev, `${path} ${t ?? ''}: ${levels.join('')}`).toBeLessThanOrEqual(1); prev = l }
    }
  }
  await check('/app')
  await check('/app/production')
  await check('/app/payments')
  await check('/app/orders')
  await check('/app/orders/2026-0020', ['Items & quote', 'Artwork', 'Purchase order', 'Purchasing', 'Production', 'Pickup', 'Payments', 'Activity'])
})

test('order tabs work from the keyboard (arrow keys move between them)', async ({ page }, info) => {
  desktopOnly(info)
  await page.goto('/app/orders/2026-0020')
  await page.getByRole('tab', { name: 'Items & quote', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Artwork', exact: true })).toBeFocused()
  await expect(page.getByRole('tab', { name: 'Artwork', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute('aria-selected', 'true')
})

test('a slow reorder response does not steal focus from an input the user moved to', async ({ page }, info) => {
  desktopOnly(info)
  await clearRunning(page)
  const first = await readyOrder(page, 'Slow first')
  await readyOrder(page, 'Slow second')
  const running = await readyOrder(page, 'Slow running')
  const job = (await production(page)).readyToStart.find((j) => j.number === running)!
  expect((await page.request.patch(`/api/app/orders/${running}/production`, { data: { to: 'in_production', expectedVersion: job.version } })).ok()).toBe(true)
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  await page.route('**/api/app/production/queue', async (route) => {
    await held
    await route.continue()
  })
  await page.goto('/app/production')
  await btn(page, 'Move down', first).focus()
  await page.keyboard.press('Enter') // the request is now held
  const units = page.getByLabel(`Units completed (number): ${running}`)
  await units.focus()
  await units.selectText()
  await page.keyboard.type('1')
  release()
  await expect.poll(async () => (await production(page)).readyToStart.map((j) => j.number).indexOf(first)).toBeGreaterThan(0)
  await expect(btn(page, 'Move up', first)).toBeEnabled() // the page has refetched and the list is idle again
  await expect(units).toBeFocused()
  await expect(units).toHaveValue('1')
  await page.unroute('**/api/app/production/queue')
  await clearRunning(page)
})

test('a slow reorder the user just waits on still returns focus to the moved row (Codex review of eb85479)', async ({ page }, info) => {
  desktopOnly(info)
  await clearRunning(page)
  const first = await readyOrder(page, 'Wait first')
  await readyOrder(page, 'Wait second')
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  await page.route('**/api/app/production/queue', async (route) => { await held; await route.continue() })
  await page.goto('/app/production')
  await btn(page, 'Move down', first).focus()
  await page.keyboard.press('Enter') // held: the arrows disable and focus is parked on their container
  await page.waitForTimeout(400) // well past the focus-recovery check
  release()
  await expect.poll(async () => (await production(page)).readyToStart.map((j) => j.number).indexOf(first)).toBeGreaterThan(0)
  await expect.poll(() => focusedLabel(page)).toMatch(new RegExp(`^Move (up|down): ${first}$`))
  await page.unroute('**/api/app/production/queue')
})

test('typing keeps focus while unrelated parts of the page change underneath', async ({ page }, info) => {
  desktopOnly(info)
  await page.goto('/app/orders/2026-0020')
  const note = page.getByLabel('Add a note')
  const other = page.getByRole('tab', { name: 'Artwork', exact: true })
  // The note stays focused throughout (never re-focused by the test) while other controls appear, disable and vanish.
  await expect(other).toBeVisible()
  await note.focus()
  await page.keyboard.type('abc')
  await inPage(page, `
    const dom = document.createElement('div'); document.body.appendChild(dom)
    for (let i = 0; i < 6; i++) setTimeout(() => { const b = document.createElement('button'); b.textContent = 'x' + i; dom.appendChild(b); b.disabled = true; b.remove() }, i * 40)
    return null`)
  await page.waitForTimeout(500)
  await expect(note).toBeFocused()
  await page.keyboard.type('def')
  await page.waitForTimeout(400)
  await expect(note).toBeFocused()
  await expect(note).toHaveValue('abcdef')
})

test('an open dialog keeps focus while the page behind it updates', async ({ page }, info) => {
  desktopOnly(info)
  const o = await makeOrder(page, 'Dialog focus')
  await page.goto(`/app/orders/${o.number}`)
  await row(page, 'authorization').getByRole('button', { name: 'Record authorization' }).click()
  await expect(dialog(page)).toBeVisible()
  await dialog(page).getByLabel('How they authorized').focus()
  await inPage(page, "window.__f = document.activeElement; return null")
  // Behind the dialog: a refetch with changed data (a note added elsewhere) and controls that appear, disable and vanish.
  expect((await page.request.post(`/api/app/orders/${o.number}/notes`, { data: { body: 'changed behind the dialog' } })).ok()).toBe(true)
  await inPage(page, `
    window.dispatchEvent(new Event('focus'))
    const host = document.querySelector('main') ?? document.body
    for (let i = 0; i < 6; i++) setTimeout(() => { const b = document.createElement('button'); b.textContent = 'x' + i; host.appendChild(b); b.disabled = true; b.remove() }, i * 40)
    return null`)
  await page.waitForTimeout(600)
  await expect(dialog(page)).toBeVisible()
  expect(await inPage<boolean>(page, 'return document.activeElement === window.__f')).toBe(true)
})
