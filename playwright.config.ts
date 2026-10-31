import { defineConfig } from '@playwright/test'

// Installed Chrome rather than a downloaded browser.
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1, // the order test changes seeded data, so tests must not overlap
  use: { baseURL: 'http://localhost:4280', channel: 'chrome' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: 'node tests/e2e/prepare.ts && npm run dev -- --port 4280 --strictPort', url: 'http://localhost:4280', reuseExistingServer: false },
})
