# GoCreative platform

Order, artwork, purchase-order and production management for GoCreative Designs,
plus a public inquiry storefront. Cloudflare Workers + D1 + R2, React + TypeScript.
Start at [AGENTS.md](AGENTS.md); the stack and schema are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup

**Prerequisites:** a recent Node and npm, and Google Chrome (the e2e tests drive the installed Chrome, not a
downloaded browser). A Cloudflare account is only needed to deploy.

```sh
npm install
cp .dev.vars.example .dev.vars   # local dev sign-in, see below
npm run db:migrate               # apply migrations to the local D1 (wrangler's default local state)
npm run db:seed                  # fictional sample data: customers, orders in every state, owner1@example.com
npm run dev                      # Vite + the Worker, usually http://localhost:5173/app
```

**Local sign-in.** In production Cloudflare Access sits in front of `/app` and `/api/app`. Locally there is
no Access, so `.dev.vars` sets `DEV_AUTH_EMAIL`, which stands in for it, only on `localhost` / `127.0.0.1`.
The email must exist and be active in `users`; the seed creates `owner1@example.com` and `owner2@example.com` (both owners).
Never set `DEV_AUTH_EMAIL` on the deployed Worker. After editing a migration that a local database already
applied, delete the local state first (`rm -rf .wrangler/state`), because wrangler will not re-run it.

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with the Worker (workerd) behind it |
| `npm run build` | `tsc -b` then `vite build` |
| `npm run typecheck` / `npm run lint` | TypeScript project build / oxlint |
| `npm test` | Vitest: domain rules and the API against an in-memory D1 |
| `npm run e2e` | Playwright against a dev server on **port 4280** (desktop 1440px and phone 390px projects) |
| `npm run verify` | lint, test, build, e2e: **the gate**. Read its exit code, not the tail of its output |
| `npm run db:migrate` / `db:seed` | local D1 migrations / seed (`scripts/seed.sql`, re-runnable) |
| `npm run db:migrate:remote` | apply migrations to the production D1 |
| `npm run deploy` | build, then `wrangler deploy` |

**The e2e port.** `npm run e2e` starts its own server on port 4280 and rebuilds its own database in
`.wrangler/e2e` (migrations plus the seed) on every run, so it never touches your dev data. Only one e2e run
can use the port at a time: a second worktree running e2e fails with "port already used", which is not a code
failure. The specs are written to run in order against one database and restore the seed when they finish.

## Migrations

Files in `migrations/` (`0001` ... ) are applied in order by wrangler.

- Local: `npm run db:migrate`.
- Remote: `npm run db:migrate:remote`. **Run it before `npm run deploy`** whenever a migration is new, because
  the new Worker code expects the new schema.
- A migration that has been applied remotely is never edited; write a new one. Remote data is real from the end
  of Phase 2, so every migration must preserve rows.

## Deploy

```sh
npm run db:migrate:remote   # only if there is a new migration
npm run deploy              # build + wrangler deploy
```

The Worker serves the storefront, the dashboard and the API from one origin. Deploying and pushing are done
deliberately, never as a side effect of other work.

## Where secrets and configuration live

- **No secrets or real email addresses are committed.** `.dev.vars` is gitignored; `.dev.vars.example` has only
  the fictional `owner1@example.com`.
- **Cloudflare Access settings** (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`) are Worker secrets, set with
  `wrangler secret put`. The two staff emails are Access policy entries and `users` rows in the production D1,
  added as in [notes/access-setup.md](notes/access-setup.md).
- **Business identity** (name, contact details, time zone, services) is in `shared/business.ts` and the brand
  tokens in `src/brand.css`; nothing else may name the business.
- **Bindings** (the D1 database and the R2 bucket) are in `wrangler.jsonc`.
- Never push or deploy unasked; commit messages go in a file and are applied with `git commit -F`.
