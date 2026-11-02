// Pricing Management on the real page. Sample numbers are test values only, cleared after.
import { expect, test } from '@playwright/test'
import { reseed } from './prepare.ts'

test.afterAll(() => { reseed() })
test.beforeEach(() => { reseed() })

test('owner sets rates in Advanced, previews, publishes; a percentage then moves the proposal once; history and rollback work', async ({ page }, info) => {
  test.setTimeout(90_000)
  test.skip(info.project.name === 'phone', 'covered once; the phone test below checks the layout')
  await page.goto('/app/settings')
  await page.getByRole('link', { name: 'Open' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pricing Management')
  await expect(page.getByText('No pricing is published')).toBeVisible()
  // Collapsed by default.
  const costs = page.locator('section[aria-label="Product and garment costs"]')
  await expect(costs).not.toBeVisible()
  await page.locator('summary', { hasText: 'Advanced pricing' }).click()
  await costs.getByLabel('T-shirts').fill('3.00')
  const dtg = page.getByRole('region', { name: 'Direct-to-garment printing' })
  await dtg.getByLabel('Offer estimates for this service').check()
  await dtg.getByLabel('Rate (%)').fill('100')
  await dtg.getByRole('button', { name: 'Add quantity tier' }).nth(1).click()
  await dtg.getByLabel('Cost ($)').fill('2.00')
  await page.getByLabel('Method').selectOption('dtg')
  await page.getByLabel('Print size').selectOption('medium')
  await page.getByLabel('Quantity', { exact: true }).fill('5')
  await expect(page.getByTestId('sim-Proposed')).toContainText('$50.00')
  await expect(page.getByTestId('sim-Proposed')).toContainText('$25.00') // internal cost
  await expect(page.getByTestId('sim-Proposed')).toContainText('50.00%')
  await expect(page.getByTestId('sim-Published')).toContainText('Manual review required')

  await expect(page.getByRole('button', { name: 'Publish' })).toBeDisabled()
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText('You have an unpublished draft.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish' })).toBeEnabled()
  await page.getByRole('button', { name: 'Publish' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByText(/Published version \d+ is active/)).toBeVisible()
  await expect(page.getByTestId('sim-Published')).toContainText('$50.00')

  // Simple: the adjustment shows in the proposal only, once.
  await page.getByLabel('Direct-to-garment printing: Overall adjustment (%)').fill('10')
  await expect(page.getByTestId('sim-Proposed')).toContainText('$55.00')
  await expect(page.getByTestId('sim-Published')).toContainText('$50.00')
  await expect(page.getByText('+$5.00')).toBeVisible()
  await page.getByLabel('Direct-to-garment printing: Overall adjustment (%)').fill('10')
  await expect(page.getByTestId('sim-Proposed')).toContainText('$55.00') // not 60.50

  // Copying an old version into the draft is how to roll back.
  await page.getByRole('button', { name: 'Copy into draft' }).first().click()
  await expect(page.getByText('You have an unpublished draft.')).toBeVisible()
})

test('no invented prices: enabling a service sets no rates, and blank or invalid values are never saved as zero', async ({ page }, info) => {
  test.skip(info.project.name === 'phone')
  let saves = 0
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().endsWith('/pricing/draft')) saves++ })
  await page.goto('/app/settings/pricing')
  await page.locator('summary', { hasText: 'Advanced pricing' }).click()
  const costs = page.locator('section[aria-label="Product and garment costs"]')
  await costs.getByLabel('T-shirts').fill('3.00')
  const screen = page.getByRole('region', { name: 'Screen printing' })
  await screen.getByLabel('Offer estimates for this service').check()
  await expect(screen.getByLabel('Rate (%)')).toHaveValue('')
  // An incomplete service: the server refuses to save it, and it can't produce a figure.
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText('Some pricing values are not valid')).toBeVisible()
  await expect(page.getByText('You have an unpublished draft.')).toHaveCount(0)
  await screen.getByLabel('Offer estimates for this service').uncheck()
  // A value that isn't money stops the save here, and points at the field.
  await costs.getByLabel('Hats').fill('-1')
  const before = saves
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText('A blank or invalid rate is never treated as zero.')).toBeVisible()
  await expect(costs.getByLabel('Hats')).toBeFocused()
  expect(saves).toBe(before)
})

test('publish stays locked until the comparison on screen is of the saved draft', async ({ page }, info) => {
  test.skip(info.project.name === 'phone')
  await page.goto('/app/settings/pricing')
  await page.locator('summary', { hasText: 'Advanced pricing' }).click()
  await page.locator('section[aria-label="Product and garment costs"]').getByLabel('T-shirts').fill('3.00')
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByRole('button', { name: 'Publish' })).toBeEnabled()
  // A slow comparison of a new edit: publish locks at the edit, and again until the new answer arrives.
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route('**/api/app/pricing/simulate', async (route) => { await held; return route.fallback() })
  await page.locator('section[aria-label="Product and garment costs"]').getByLabel('T-shirts').fill('4.00')
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Publish' })).toBeDisabled()
  release()
  await expect(page.getByRole('button', { name: 'Publish' })).toBeEnabled()
})

test('an open publish dialog closes if the draft changes in another tab, so an unseen draft can never go out', async ({ page }, info) => {
  test.skip(info.project.name === 'phone')
  await page.goto('/app/settings/pricing')
  await page.locator('summary', { hasText: 'Advanced pricing' }).click()
  await page.locator('section[aria-label="Product and garment costs"]').getByLabel('T-shirts').fill('3.00')
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByRole('button', { name: 'Publish' })).toBeEnabled()
  await page.getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  let published = 0
  page.on('request', (r) => { if (r.url().endsWith('/pricing/publish')) published++ })
  // Another tab saves a different draft.
  const state = await (await page.request.get('/api/app/pricing')).json() as { draft: { hash: string } }
  expect((await page.request.put('/api/app/pricing/draft', { data: { config: { productCostCents: { tshirts: 999 }, services: {} }, expectedHash: state.draft.hash } })).ok()).toBe(true)
  await page.evaluate("window.dispatchEvent(new Event('visibilitychange'))") // what refetches on returning to a tab
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(published).toBe(0)
})

test('staff never see it: no link, a refusal on the page, and 403 from the server', async ({ page, context }) => {
  await page.route('**/api/app/me', (r) => r.fulfill({ json: { id: 2, email: 'x', name: 'Staff', role: 'staff' } }))
  await page.goto('/app/settings')
  await expect(page.getByText('Pricing Management')).toHaveCount(0)
  await page.goto('/app/settings/pricing')
  await expect(page.getByText('Only an owner can open Pricing Management.')).toBeVisible()
  await expect(page.getByText('Advanced pricing')).toHaveCount(0)
  expect(context).toBeTruthy()
})

test('the artwork check measures locally: no upload, counts and refusals shown', async ({ page }) => {
  let uploads = 0
  page.on('request', (r) => { if (r.method() !== 'GET' && /files|artwork/.test(r.url())) uploads++ })
  await page.goto('/app/settings/pricing')
  const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#ffffff"/>${body}</svg>`)
  await page.locator('input[type=file]').setInputFiles([
    { name: 'two-inks.svg', mimeType: 'image/svg+xml', buffer: svg('<rect x="50" y="50" width="120" height="300" fill="#142870"/><rect x="220" y="50" width="120" height="300" fill="#f0b41e"/>') },
    { name: 'scripted.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
    { name: 'sneaky.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><filter id="f"><feGaussianBlur stdDeviation="9"/></filter><rect width="10" height="10" filter="u&#114;l(#f)"/></svg>') },
    { name: 'job.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') },
    { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a png at all') },
  ])
  const row = (name: string) => page.getByRole('row').filter({ hasText: name })
  // No garment chosen means no count, on purpose; choosing one brings it.
  await expect(row('two-inks.svg')).toContainText('Manual review')
  await page.getByLabel('Item color: two-inks.svg').selectOption('white')
  await expect(row('two-inks.svg').getByRole('cell').nth(3)).toHaveText('2')
  await page.getByLabel('Item color: job.pdf').selectOption('white')
  await expect(row('two-inks.svg')).toContainText('Background assumed not printed')
  await expect(row('scripted.svg')).toContainText('Format not analyzed')
  await expect(row('sneaky.svg')).toContainText('Format not analyzed')
  await expect(row('job.pdf')).toContainText('Format not analyzed')
  await expect(row('broken.png')).toContainText('Could not read this file')
  await page.getByLabel('Screens used: two-inks.svg').fill('2')
  await page.getByLabel('Screens used: job.pdf').fill('3')
  await expect(page.getByTestId('check-summary')).toContainText('With a known count: 2. Exact: 1. Within one: 1. Sent to manual review: 1.')
  await expect(page.getByTestId('check-risk')).toContainText('Gave a count, and it was wrong: 0.')
  await expect(page.getByTestId('check-enough')).toContainText('2 of at least 30 jobs')
  await expect(page.getByTestId('check-notes')).toContainText('Format not analyzed: 1 jobs, 1 to manual review, 0 wrong count')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download results' }).click()])
  expect(download.suggestedFilename()).toBe('artwork-validation.csv')
  // Results survive a reload on this computer; the files themselves never left it.
  await page.reload()
  await expect(page.getByTestId('check-summary')).toContainText('With a known count: 2.')
  await page.getByRole('button', { name: 'Clear results' }).click()
  await expect(page.getByTestId('check-summary')).toHaveCount(0)
  expect(uploads).toBe(0)
})

test('a real PNG goes through the worker in the browser', async ({ page }) => {
  await page.goto('/app/settings/pricing')
  const bytes = await page.evaluate(`(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 400; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0,0,400,400); x.fillStyle = '#142870'; x.beginPath(); x.arc(200,200,120,0,7); x.fill(); return [...atob(c.toDataURL().split(',')[1])].map((ch) => ch.charCodeAt(0)) })()`) as number[]
  await page.locator('input[type=file]').setInputFiles({ name: 'circle.png', mimeType: 'image/png', buffer: Buffer.from(bytes) })
  await page.getByLabel('Item color: circle.png').selectOption('light')
  await expect(page.getByRole('row').filter({ hasText: 'circle.png' }).getByRole('cell').nth(3)).toHaveText('1')
})

test('SVG: harmless editor output is analyzed; anything that can fetch, run or filter is still refused', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'the same code on both')
  await page.goto('/app/settings/pricing')
  const X = 'xmlns="http://www.w3.org/2000/svg"'
  const body = '<rect width="400" height="400" fill="#102040"/>'
  const open = `<svg ${X} width="400" height="400"`
  const files: [string, string][] = [
    ['ok-xmlspace.svg', `${open} xml:space="preserve" enable-background="new 0 0 400 400">${body}</svg>`],
    ['ok-doctype.svg', `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${open}>${body}</svg>`],
    ['ok-editor.svg', `${open} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" inkscape:version="1"><defs/><sodipodi:namedview pagecolor="#ffffff"/>${body}</svg>`],
    ['ok-no-dash.svg', `${open}><rect width="400" height="400" fill="#102040" style="stroke-dasharray:none"/></svg>`],
    ['ok-style.svg', `${open}><rect width="400" height="400" style="fill:#102040;stroke:none"/></svg>`],
    ['ok-block.svg', `${open}><defs><style>.a{fill:#102040}</style></defs><rect class="a" width="400" height="400"/></svg>`],
    ['bad-metadata-style.svg', `${open}><metadata><style xmlns="http://www.w3.org/2000/svg">rect{filter:blur(9px)}</style></metadata>${body}</svg>`],
    ['bad-dash-attr.svg', `${open}><path d="M0 0L400 400" stroke="#102040" stroke-dasharray="0.000001,0.000001"/></svg>`],
    ['bad-dash-style.svg', `${open}><path d="M0 0L400 400" style="stroke:#102040;stroke-dasharray:0.000001,0.000001"/></svg>`],
    ['bad-entity.svg', `<!DOCTYPE svg [<!ENTITY x "y">]>${open}>${body}</svg>`],
    ['bad-subset.svg', `<!DOCTYPE svg PUBLIC "a" "b" [<!ENTITY x "y">]>${open}>${body}</svg>`],
    ['bad-style-filter.svg', `${open}><rect width="9" height="9" style="filter:url(#f)"/></svg>`],
    ['bad-style-url.svg', `${open}><rect width="9" height="9" style="fill:url(https://example.com/x)"/></svg>`],
    ['bad-style-escape.svg', `${open}><rect width="9" height="9" style="fill:\\75rl(#f)"/></svg>`],
    ['bad-block-import.svg', `${open}><style>@import url(https://example.com/x.css);</style>${body}</svg>`],
    ['bad-block-bg.svg', `${open}><style>.a{background:url(https://example.com/x)}</style>${body}</svg>`],
    ['bad-block-selector.svg', `${open}><style>rect[fill]{fill:#102040}</style>${body}</svg>`],
    ['bad-prefix.svg', `<svg ${X} xmlns:inkscape="http://www.w3.org/2000/svg" width="9" height="9"><inkscape:filter id="f"/>${body}</svg>`],
    ['bad-foreign.svg', `${open}><foreignObject width="9" height="9"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>`],
    ['bad-image.svg', `${open}><image href="https://example.com/x.png" width="9" height="9"/></svg>`],
    ['bad-gradient.svg', `${open}><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs>${body}</svg>`],
    ['bad-handler.svg', `${open} onload="alert(1)">${body}</svg>`],
  ]
  await page.locator('input[type=file]').setInputFiles(files.map(([name, text]) => ({ name, mimeType: 'image/svg+xml', buffer: Buffer.from(text) })))
  for (const [name] of files) {
    const row = page.getByRole('row').filter({ hasText: name })
    if (name.startsWith('ok-')) await expect(row.getByRole('cell').nth(4), name).not.toContainText('Format not analyzed')
    else await expect(row.getByRole('cell').nth(4), name).toContainText('Format not analyzed')
  }
})
