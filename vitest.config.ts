import { defineConfig } from 'vitest/config'

// Pure-logic tests (worker/domain, shared) and API tests (tests/api, plain Vitest over node:sqlite: the Workers pool doesn't support vitest 5 yet).
export default defineConfig({
  test: { include: ['worker/**/*.test.ts', 'shared/**/*.test.ts', 'tests/api/**/*.test.ts'], globals: true, passWithNoTests: true },
})
