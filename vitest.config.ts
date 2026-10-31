import { defineConfig } from 'vitest/config'

// Pure-logic tests (worker/domain, shared), API tests (tests/api, plain Vitest over node:sqlite: the Workers pool doesn't support vitest 5 yet)
// and the real-workerd D1 batch check (tests/d1, about 3 s: it boots wrangler's getPlatformProxy).
export default defineConfig({
  test: { include: ['worker/**/*.test.ts', 'shared/**/*.test.ts', 'tests/api/**/*.test.ts', 'tests/d1/**/*.test.ts'], globals: true, passWithNoTests: true },
})
