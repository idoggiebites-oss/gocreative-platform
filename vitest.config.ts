import { defineConfig } from 'vitest/config'

// Pure-logic tests (worker/domain, shared). API tests on the Workers pool join in ROADMAP 1.4.
export default defineConfig({
  test: { include: ['worker/**/*.test.ts', 'shared/**/*.test.ts'], globals: true, passWithNoTests: true },
})
