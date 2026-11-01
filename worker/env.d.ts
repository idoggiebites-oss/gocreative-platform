interface Env {
  DB: D1Database
  FILES: R2Bucket
  /** Application Audience (AUD) tag of the Access application. */
  ACCESS_AUD?: string
  /** Team domain, e.g. myteam.cloudflareaccess.com (no scheme). */
  ACCESS_TEAM_DOMAIN?: string
  /** Local dev only: honoured solely on localhost/127.0.0.1. Never set in production. */
  DEV_AUTH_EMAIL?: string
  /** Turnstile secret key. Without it public intake refuses to open sessions. */
  TURNSTILE_SECRET?: string
  /** Turnstile site key. Public; the form needs it to render the widget. */
  TURNSTILE_SITE_KEY?: string
  /** Local dev and e2e only: skips Turnstile, honoured solely on localhost/127.0.0.1. Never set in production. */
  DEV_TURNSTILE_PASS?: string
  /** Salt for hashing visitor IPs. Without it public intake refuses to open sessions. */
  IP_HASH_SALT?: string
}
