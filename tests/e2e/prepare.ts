// Runs before the dev server starts (playwright.config.ts webServer): the e2e tests need
// DEV_AUTH_EMAIL and a migrated, seeded D1 in .wrangler/e2e (never the developer's default local state). Also re-run by the mutating test to restore the seed.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'

export function reseed() {
  const run = (...args: string[]) => execFileSync('npx', ['wrangler', 'd1', ...args, '--local', '--persist-to', '.wrangler/e2e'], { stdio: 'pipe' })
  run('migrations', 'apply', 'gocreative')
  run('execute', 'gocreative', '--file', 'scripts/seed.sql')
}

export function prepare() {
  if (!existsSync('.dev.vars')) copyFileSync('.dev.vars.example', '.dev.vars')
  reseed()
}

if (import.meta.url === `file://${process.argv[1]}`) prepare()
