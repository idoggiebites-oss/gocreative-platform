import type { MiddlewareHandler } from 'hono'

/**
 * Writes must come from this site (Codex Phase 2 security review). The Access cookie rides along on a cross-site
 * request, so a valid JWT proves who, not intent: any unsafe method whose Origin is another site, or whose
 * Sec-Fetch-Site says cross-site/same-site, is refused before auth. Browsers send Origin on a cross-origin POST (as
 * `null` when the page hides it, refused too); requests without either header (curl, tests) aren't a browser riding a cookie.
 */
export const sameOriginWrites: MiddlewareHandler = async (c, next) => {
  if (!/^(GET|HEAD|OPTIONS)$/.test(c.req.method)) {
    const origin = c.req.header('origin')
    const site = c.req.header('sec-fetch-site')
    if ((origin && origin !== new URL(c.req.url).origin) || (site && site !== 'same-origin' && site !== 'none')) {
      return c.json({ error: 'Cross-site request refused', code: 'cross_site_request' }, 403)
    }
  }
  await next()
}
