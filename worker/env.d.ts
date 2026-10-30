interface Env {
  DB: D1Database
  FILES: R2Bucket
  /** Application Audience (AUD) tag of the Access application. */
  ACCESS_AUD?: string
  /** Team domain, e.g. myteam.cloudflareaccess.com (no scheme). */
  ACCESS_TEAM_DOMAIN?: string
  /** Local dev only: honoured solely on localhost/127.0.0.1. Never set in production. */
  DEV_AUTH_EMAIL?: string
}
