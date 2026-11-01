// The storefront against the real local API (Turnstile aside: localhost skips it, and one test stubs the widget).
import { expect, test, type Page } from '@playwright/test'
import { reseed } from './prepare.ts'

test.afterAll(() => { reseed() })

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex')
const png = (name = 'logo.png') => ({ name, mimeType: 'image/png', buffer: PNG })
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 600
const toStep2 = async (page: Page, product = 'T-shirts', method = 'Screen printing') => {
  await page.goto('/order')
  await page.getByRole('radio', { name: new RegExp(`^${product}`) }).check({ force: true })
  await page.getByRole('radio', { name: method }).check({ force: true })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/How many/)
}
const toStep3 = async (page: Page) => {
  await toStep2(page)
  await page.getByLabel('M', { exact: true }).fill('2')
  await page.getByLabel('L', { exact: true }).fill('1')
  await page.getByRole('button', { name: 'Continue to artwork' }).click()
  await expect(page.getByRole('heading', { name: 'Send us your artwork.' })).toBeVisible()
}
const artworkInput = (page: Page) => page.locator('input[type=file][multiple]')
const toStep4 = async (page: Page) => {
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await expect(page.getByRole('heading', { name: 'How can we reach you?' })).toBeVisible()
  await page.getByLabel('Your name').fill('Rosa Medrano')
  await page.getByLabel('Email').fill('rosa@example.com')
}

test('home and services show the business, with labelled placeholders and no invented facts', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: /Custom apparel/ })).toBeVisible()
  const text = await page.locator('footer').innerText()
  for (const slot of ['[Shop address]', '[Phone number]', '[Email address]', '[Opening hours]']) expect(text).toContain(slot)
  expect(await page.locator('body').innerText()).not.toMatch(/\$\d|\(\d{3}\)|\d{3}-\d{4}|\d+ (business )?days/i)
  await expect(page.getByText(/^Placeholder photo:/).first()).toBeVisible()
  await page.goto('/services')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The right method for every project.')
  await expect(page.getByRole('heading', { name: 'Trophies and awards' })).toBeVisible()
  await page.goto('/privacy')
  await expect(page.getByText('pending review')).toBeVisible()
  await page.goto('/nope')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('We could not find that page.')
})

test('no page scrolls sideways at phone widths', async ({ page }) => {
  test.skip(!isPhone(page))
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 })
    for (const path of ['/', '/services', '/privacy', '/order']) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      expect(await page.evaluate('document.documentElement.scrollWidth - innerWidth'), `${path} at ${width}`).toBeLessThanOrEqual(0)
    }
  }
})

test('the phone menu opens, closes on Escape with focus back, and every target is tappable', async ({ page }) => {
  test.skip(!isPhone(page))
  await page.goto('/')
  const button = page.getByRole('button', { name: 'Open menu' })
  await button.click()
  await expect(page.getByRole('link', { name: 'How it works' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused()
  const small = await page.evaluate(`[...document.querySelectorAll('main a.s-btn, .s-sticky-cta a, header button')].filter((e) => { const h = e.getBoundingClientRect().height; return h > 0 && h < 44 }).length`)
  expect(small).toBe(0)
})

test('methods follow the product: a hat is never screen printed, and changing product clears what no longer fits', async ({ page }) => {
  await page.goto('/order')
  await page.getByRole('radio', { name: /^T-shirts/ }).check({ force: true })
  await page.getByRole('radio', { name: 'Screen printing' }).check({ force: true })
  await page.getByRole('radio', { name: /^Hats/ }).check({ force: true })
  await expect(page.getByRole('radio', { name: 'Screen printing' })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: 'Embroidery' })).toBeChecked() // the only method, so it is chosen
  await expect(page.getByRole('radio', { name: 'Help me choose' })).toBeVisible()
  await page.getByRole('radio', { name: /^Trophies/ }).check({ force: true })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How many do you need?')
  await expect(page.getByLabel(/Names or wording/)).toBeVisible()
  await expect(page.getByLabel('M', { exact: true })).toHaveCount(0) // no size grid
})

test('a service link starts the order with its method; hats ignore a method that does not fit', async ({ page }) => {
  await page.goto('/services')
  await page.getByRole('link', { name: 'Start an order for embroidery' }).click()
  await expect(page).toHaveURL(/order\?method=embroidery/)
  await page.getByRole('radio', { name: /^Hats/ }).check({ force: true })
  await expect(page.getByRole('radio', { name: 'Embroidery' })).toBeChecked()
})

test('keyboard: arrow keys move through choices, errors land on the field, and each step takes focus', async ({ page }) => {
  await page.goto('/order')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByText('Choose what you would like made.')).toBeVisible()
  await expect(page.getByRole('radio', { name: /^T-shirts/ })).toBeFocused() // focus lands on the group with the problem
  await expect(page.getByRole('alert')).toContainText('highlighted')
  await page.getByRole('radio', { name: /^T-shirts/ }).focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('radio', { name: /^T-shirts/ })).toBeChecked()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('radio', { name: /^Hoodies/ })).toBeChecked()
  await page.getByRole('radio', { name: 'Direct to garment' }).check({ force: true })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
  await expect(page.getByRole('status').filter({ hasText: 'Step 2 of 4: How many' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Continue to artwork' }).click()
  await expect(page.getByText('Add a quantity to at least one size.')).toBeVisible()
  await expect(page.getByLabel('YS')).toBeFocused()
  await expect(page.getByLabel('YS')).toHaveAttribute('aria-invalid', 'true')
  // The browser's back gesture moves one step, not out of the form.
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('What would you like made?')
  await expect(page.getByRole('radio', { name: /^Hoodies/ })).toBeChecked()
})

test('the whole path: a request with artwork reaches the dashboard, with a reference and nothing typed twice', async ({ page }) => {
  await toStep3(page)
  await artworkInput(page).setInputFiles([png('eagles-front.png')])
  await expect(page.getByText(/^Artwork, .*Uploaded\.$/)).toBeVisible()
  await expect(page.getByRole('img', { name: 'Preview of eagles-front.png' })).toBeVisible()
  await toStep4(page)
  await expect(page.getByLabel('Review your request')).toContainText('T-shirts, screen printing. 3 total. 1 file attached.')
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page).toHaveURL(/order\/sent\/INQ-[2-9A-HJ-NP-Z]{6}$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thanks. We have your request.')
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
  const ref = page.url().split('/').pop()!
  await expect(page.getByText(ref, { exact: true })).toBeVisible()
  await expect(page.getByLabel('What you sent')).toContainText('eagles-front.png')
  // Going back can't send it twice, and the draft is gone.
  expect(await page.evaluate(`sessionStorage.getItem('inquiry-draft')`)).toBeNull()
  const inquiries = await (await page.request.get('/api/app/orders?view=inquiries')).json() as { rows: { contactName?: string; contact_name?: string; ref?: string }[] }
  expect(JSON.stringify(inquiries.rows)).toContain('Rosa Medrano')
})

test('a school attaches a PO; the choice locks while the PO is attached; only PDF, PNG or JPG', async ({ page }) => {
  await toStep3(page)
  await expect(page.getByText('Attach a purchase order')).toHaveCount(0)
  await page.getByLabel('Ordering for a school, district or organization').check()
  const po = page.locator('input[type=file][accept*=".pdf"]:not([multiple])')
  await po.setInputFiles({ name: 'po.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') })
  await expect(page.getByRole('alert')).toContainText('a purchase order can be PDF, PNG or JPG')
  await po.setInputFiles({ name: 'po.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n') })
  await expect(page.getByText(/^Purchase order, .*Uploaded\.$/)).toBeVisible()
  await expect(page.getByLabel('Ordering for a school, district or organization')).toBeDisabled()
  await toStep4(page)
  await expect(page.getByLabel('School, district or organization')).toBeVisible()
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page.getByText('Tell us the name of the school, district or organization.')).toBeVisible()
  await page.getByLabel('School, district or organization').fill('Valley ISD')
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page.getByLabel('What you sent')).toContainText('PO attached, to be confirmed with you.')
})

test('upload states: too many, wrong type and empty are refused here; a failure can be retried; removing really removes', async ({ page }) => {
  await toStep3(page)
  await artworkInput(page).setInputFiles([{ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<html>') }, { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) }])
  await expect(page.getByRole('alert')).toContainText('page.html: use PNG, JPG, PDF or SVG')
  await expect(page.getByRole('alert')).toContainText('empty.png: this file is empty')

  let fail = true
  await page.route('**/api/public/submissions/files', (route) => {
    if (fail && route.request().method() === 'POST') { fail = false; return route.abort() }
    return route.fallback()
  })
  await artworkInput(page).setInputFiles([png('flaky.png')])
  await expect(page.getByRole('list', { name: 'Your files' }).getByText('We could not reach the shop.')).toBeVisible()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await expect(page.getByRole('alert')).toContainText('Retry or remove')
  await page.getByRole('button', { name: 'Retry flaky.png' }).click()
  await expect(page.getByText(/^Artwork, .*Uploaded\.$/)).toBeVisible()

  await page.getByRole('button', { name: 'Remove flaky.png' }).click()
  await expect(page.getByRole('list', { name: 'Your files' })).toHaveCount(0)
  await artworkInput(page).setInputFiles(Array.from({ length: 6 }, (_, i) => png(`f${i}.png`)))
  await expect(page.getByRole('alert')).toContainText('f5.png: you can send up to 5 files')
  await expect(page.getByText(/^Artwork, .*Uploaded\.$/)).toHaveCount(5)
})

test('a lost upload reply: the file is recognised, not sent twice, and retry is never offered', async ({ page }) => {
  await toStep3(page)
  await page.route('**/api/public/submissions/files', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await route.fetch() // stored on the server; only the acknowledgement is lost
    return route.abort()
  })
  await artworkInput(page).setInputFiles([png('reached.png')])
  await expect(page.getByText(/^Artwork, .*Uploaded\.$/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry reached.png' })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'reached.png uploaded.' })).toHaveCount(1)
})

test('cancelling while the session is still opening sends nothing', async ({ page }) => {
  await toStep3(page)
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route('**/api/public/submissions', async (route) => { await held; return route.fallback() })
  let posts = 0
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/submissions/files')) posts++ })
  await artworkInput(page).setInputFiles([png('changed-my-mind.png')])
  await page.getByRole('button', { name: 'Cancel changed-my-mind.png' }).click()
  await expect(page.getByRole('list', { name: 'Your files' })).toHaveCount(0)
  release()
  await page.waitForResponse('**/api/public/submissions')
  await page.waitForTimeout(300)
  expect(posts).toBe(0)
})

test('a file cancelled after it reached the server is removed before sending, so it never goes out', async ({ page }) => {
  await toStep3(page)
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route('**/api/public/submissions/files', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const reply = await route.fetch()
    await held
    return route.fulfill({ response: reply })
  })
  await artworkInput(page).setInputFiles([png('sent-then-cancelled.png')])
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Cancel sent-then-cancelled.png' }).click()
  release()
  await toStep4(page)
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page).toHaveURL(/order\/sent\//)
  await expect(page.getByLabel('What you sent')).not.toContainText('sent-then-cancelled.png')
})

test('reloading while the reply was lost still shows the file that would be sent', async ({ page }) => {
  await toStep3(page)
  await artworkInput(page).setInputFiles([png('first.png')])
  await expect(page.getByText(/^Artwork, .*Uploaded\.$/)).toBeVisible()
  // Stored on the server, but the browser never recorded it.
  await page.evaluate(`(() => { const d = JSON.parse(sessionStorage.getItem('inquiry-draft')); d.files = []; sessionStorage.setItem('inquiry-draft', JSON.stringify(d)) })()`)
  await page.reload()
  await expect(page.getByRole('list', { name: 'Your files' }).getByText('first.png')).toBeVisible()
})

test('past the attempt limit, the customer can start the uploads again', async ({ page }) => {
  await toStep3(page)
  let limited = true
  await page.route('**/api/public/submissions/files', (route) => {
    if (limited && route.request().method() === 'POST') { limited = false; return route.fulfill({ status: 429, json: { code: 'upload_limit', error: 'x' } }) }
    return route.fallback()
  })
  await artworkInput(page).setInputFiles([png('again.png')])
  await page.getByRole('button', { name: 'Start the uploads again' }).click()
  await expect(page.getByText(/^Artwork, .*Uploaded\.$/)).toBeVisible()
})

test('a file is sent once, even under StrictMode', async ({ page }) => {
  await toStep3(page)
  let posts = 0
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/submissions/files')) posts++ })
  await artworkInput(page).setInputFiles([png()])
  await expect(page.getByText(/^Artwork, .*Uploaded\.$/)).toBeVisible()
  expect(posts).toBe(1)
})

test('sending: a lost response keeps everything, and sending again gives one inquiry with one reference', async ({ page }) => {
  await toStep3(page)
  await toStep4(page)
  const before = (await (await page.request.get('/api/app/orders?view=inquiries')).json() as { rows: unknown[] }).rows.length
  let drop = true
  await page.route('**/api/public/submissions/submit', async (route) => {
    if (!drop) return route.fallback()
    drop = false
    await route.fetch() // the server got it; only the reply is lost
    return route.abort()
  })
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page.getByRole('alert')).toContainText('Your details are still here.')
  await expect(page.getByLabel('Your name')).toHaveValue('Rosa Medrano')
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page).toHaveURL(/order\/sent\//)
  const after = (await (await page.request.get('/api/app/orders?view=inquiries')).json() as { rows: unknown[] }).rows.length
  expect(after).toBe(before + 1)
})

test('a session that ended: the files go up again, nothing typed is lost', async ({ page }) => {
  await toStep3(page)
  await artworkInput(page).setInputFiles([png('kept.png')])
  await expect(page.getByText(/^Artwork, .*Uploaded\.$/)).toBeVisible()
  await toStep4(page)
  let expired = true
  await page.route('**/api/public/submissions/submit', (route) => {
    if (!expired) return route.fallback()
    expired = false
    return route.fulfill({ status: 401, json: { code: 'session_invalid', error: 'Your session has ended. Please start again.' } })
  })
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page.getByRole('alert')).toContainText('need to go up again')
  await page.getByRole('button', { name: 'Retry kept.png' }).click()
  await expect(page.getByText(/^Artwork, .*Uploaded\.$/)).toBeVisible()
  await page.getByRole('button', { name: 'Continue to your details' }).click()
  await expect(page.getByLabel('Your name')).toHaveValue('Rosa Medrano')
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page).toHaveURL(/order\/sent\//)
})

test('a reload, as a phone does when the camera opens, keeps the form and the uploaded file', async ({ page }) => {
  await toStep3(page)
  await artworkInput(page).setInputFiles([png('survives.png')])
  await expect(page.getByText(/^Artwork, .*Uploaded\.$/)).toBeVisible()
  await page.reload()
  await expect(page.getByRole('list', { name: 'Your files' }).getByText('survives.png')).toBeVisible()
  await toStep4(page)
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page.getByLabel('What you sent')).toContainText('survives.png')
})

test('closed, loading and unreachable each say so plainly, and the form never appears when closed', async ({ page }) => {
  await page.route('**/api/public/status', (route) => route.fulfill({ json: { open: false, turnstileSiteKey: null } }))
  await page.goto('/order')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('We are not taking online requests right now.')
  await expect(page.getByText('[phone number]')).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(0)
  await page.unroute('**/api/public/status')

  let down = true
  await page.route('**/api/public/status', (route) => (down ? route.abort() : route.fallback()))
  await page.goto('/order')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('We could not load the form.')
  down = false
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('What would you like made?')
})

test('the off switch mid-form stops the upload and shows the closed message', async ({ page }) => {
  await toStep3(page)
  await page.route('**/api/public/submissions', (route) => route.fulfill({ status: 503, json: { code: 'intake_closed', error: 'closed' } }))
  await artworkInput(page).setInputFiles([png()])
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('We are not taking online requests right now.')
})

test('Turnstile: the widget is asked for action "inquiry", its token opens the session, and browsing never loads it', async ({ page }) => {
  let scriptLoads = 0
  await page.route('https://challenges.cloudflare.com/**', (route) => {
    scriptLoads++
    return route.fulfill({ contentType: 'text/javascript', body: `window.turnstile = { render: (el, o) => { window.__ts = o; return 'w' }, execute: () => window.__ts.callback('stub-token'), remove: () => {} }` })
  })
  await page.route('**/api/public/status', (route) => route.fulfill({ json: { open: true, turnstileSiteKey: 'site-key' } }))
  await page.goto('/')
  await page.goto('/order')
  await page.getByRole('radio', { name: /^Hats/ }).check({ force: true })
  expect(scriptLoads).toBe(0)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByLabel('Quantity').fill('4')
  await page.getByRole('button', { name: 'Continue to artwork' }).click()
  const opened = page.waitForRequest((r) => r.url().endsWith('/api/public/submissions'))
  await artworkInput(page).setInputFiles([png()])
  expect((await opened).postDataJSON()).toEqual({ turnstileToken: 'stub-token' })
  expect(scriptLoads).toBe(1)
  expect(await page.evaluate('({ action: window.__ts.action, sitekey: window.__ts.sitekey })')).toMatchObject({ action: 'inquiry', sitekey: 'site-key' })
})

test('the honeypot cannot be reached by keyboard or seen, and a filled one lands as spam while looking accepted', async ({ page }) => {
  await toStep3(page)
  await toStep4(page)
  const trap = page.locator('#website')
  await expect(trap).toHaveAttribute('tabindex', '-1')
  await expect(trap.locator('..')).toHaveAttribute('aria-hidden', 'true')
  await trap.fill('http://spam.example')
  await page.getByRole('button', { name: 'Send my request' }).click()
  await expect(page).toHaveURL(/order\/sent\//)
})

test('reduced motion: nothing moves, and content is on screen immediately', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.locator('.s-tile').first()).toBeVisible()
  const transform = await page.evaluate(`getComputedStyle(document.querySelector('.s-steps li')).transform`) as string
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(transform)
  await context.close()
})

test('the dashboard never downloads the storefront motion library', async ({ page }) => {
  const scripts: string[] = []
  page.on('response', (r) => { if (/\.(js|tsx?)(\?|$)/.test(r.url())) scripts.push(r.url()) })
  await page.goto('/app')
  await page.waitForLoadState('networkidle')
  expect(scripts.filter((s) => /motion|\/store\//.test(s))).toEqual([])
})
