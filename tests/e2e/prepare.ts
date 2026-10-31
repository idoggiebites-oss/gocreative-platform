// Runs before the dev server starts (playwright.config.ts webServer): the e2e tests need
// DEV_AUTH_EMAIL and a migrated, seeded D1 in .wrangler/e2e (never the developer's default local state). Also re-run by the mutating test to restore the seed.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'

export function reseed() {
  const run = (...args: string[]) => execFileSync('npx', ['wrangler', 'd1', ...args, '--local', '--persist-to', '.wrangler/e2e'], { stdio: 'pipe' })
  run('migrations', 'apply', 'gocreative')
  run('execute', 'gocreative', '--file', 'scripts/seed.sql')
}

export function prepare() {
  if (!existsSync('.dev.vars')) copyFileSync('.dev.vars.example', '.dev.vars')
  // Start from an empty database every run: wrangler won't re-run a migration it has already
  // applied, so an edited migration would otherwise leave this state on the old schema.
  rmSync('.wrangler/e2e', { recursive: true, force: true })
  reseed()
}

if (import.meta.url === `file://${process.argv[1]}`) prepare()
