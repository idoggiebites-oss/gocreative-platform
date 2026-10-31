// Runs before the dev server starts (playwright.config.ts webServer): the e2e tests need
// DEV_AUTH_EMAIL and a migrated, seeded local D1. Also re-run by the mutating test to restore the seed.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'

export function reseed() {
  const run = (...args: string[]) => execFileSync('npx', ['wrangler', 'd1', ...args, '--local'], { stdio: 'pipe' })
  run('migrations', 'apply', 'gocreative')
  run('execute', 'gocreative', '--file', 'scripts/seed.sql')
}

export function prepare() {
  if (!existsSync('.dev.vars')) copyFileSync('.dev.vars.example', '.dev.vars')
  reseed()
}

if (import.meta.url === `file://${process.argv[1]}`) prepare()
