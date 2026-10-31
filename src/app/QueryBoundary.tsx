import type { ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { LockKeyhole, TriangleAlert } from 'lucide-react'
import { useI18n } from '@/i18n'
import { ApiError } from '@/lib/api'
import { CARD, PAGE } from './ui'

/** Full-page answer to a failed read: the sign-in problems get their own words, never a spinner. */
export function ApiProblem({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const { m } = useI18n()
  const status = error instanceof ApiError ? error.status : 0
  const notConfigured = error instanceof ApiError && error.body.error === 'auth_not_configured'
  const text = status === 401 ? m.api.unauthenticated : status === 403 ? m.api.forbidden : notConfigured ? m.api.notConfigured : m.api.failed
  const locked = status === 401 || status === 403 || notConfigured
  const Icon = locked ? LockKeyhole : TriangleAlert
  return (
    <div className={PAGE}>
      <section role="alert" className={`${CARD} flex flex-col items-center gap-3 px-6 py-16 text-center`}>
        <div className="flex size-10 items-center justify-center rounded-full bg-secondary text-muted-foreground"><Icon className="size-5" strokeWidth={1.75} aria-hidden /></div>
        <p className="text-sm font-semibold">{text.title}</p>
        <p className="max-w-sm text-[13px] text-muted-foreground">{text.body}</p>
        {!locked && onRetry && (
          <button type="button" onClick={onRetry} className="h-8 rounded-[7px] border border-input bg-card px-3 text-[13px] font-medium hover:bg-secondary">{m.common.retry}</button>
        )}
      </section>
    </div>
  )
}

export function Loading() {
  const { m } = useI18n()
  return <div className={PAGE}><p role="status" className="text-[13px] text-muted-foreground">{m.common.loading}</p></div>
}

/** Cached data stays on screen when a refetch fails, so say so (announced) and offer a retry. */
function StaleNotice({ query }: { query: UseQueryResult<unknown, Error> }) {
  const { m } = useI18n()
  return (
    <div role="status" aria-live="polite">
      {query.isError && (
        <div className="mx-auto w-full max-w-[1240px] px-4 pt-4 sm:px-8">
          <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-status-amber-fg/20 bg-status-amber px-3.5 py-2.5 text-[13px] text-status-amber-fg">
            <TriangleAlert className="size-4 shrink-0" strokeWidth={1.9} aria-hidden />
            <span className="min-w-0 flex-1">{m.api.staleNotice}</span>
            <button type="button" onClick={() => void query.refetch()} className="h-7 rounded-[7px] border border-input bg-card px-3 text-[13px] font-medium text-foreground hover:bg-secondary">{m.common.retry}</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function QueryBoundary<T>({ query, children, notFound }: { query: UseQueryResult<T, Error>; children: (data: T) => ReactNode; notFound?: ReactNode }) {
  if (query.data !== undefined) return <><StaleNotice query={query} />{children(query.data)}</>
  if (query.error) {
    if (notFound && query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 400)) return <>{notFound}</>
    return <ApiProblem error={query.error} onRetry={() => void query.refetch()} />
  }
  return <Loading />
}
