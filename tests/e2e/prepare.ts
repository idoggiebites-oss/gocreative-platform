// Runs before the dev server starts (playwright.config.ts webServer): the e2e tests need
// DEV_AUTH_EMAIL and a migrated, seeded D1 in .wrangler/e2e (never the developer's default local state). Also re-run by the mutating test to restore the seed.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'

export function reseed() {
  // ponytail: retries a symptom. This process shares the SQLite files with the running dev server and workerd sometimes answers "internal error" (2 of 6 verify runs, 2026-11-01). Serve reseeds through the app if retries ever stop being enough.
  const run = (...args: string[]) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return execFileSync('npx', ['wrangler', 'd1', ...args, '--local', '--persist-to', '.wrangler/e2e'], { stdio: 'pipe' })
      } catch (e) {
        if (attempt === 3 || !String((e as { stderr?: Buffer }).stderr).includes('internal error')) throw e
      }
    }
  }
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
