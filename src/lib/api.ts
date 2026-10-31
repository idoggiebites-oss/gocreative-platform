import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  DashboardResponse, OrderDetailResponse, OrdersListResponse, OrderView, PoChangeResponse, ProductionChangeResponse,
} from '@shared/api'
import type { PoStatus, ProductionStatus } from '@shared/enums'
import type { ApiError as ApiErrorBody } from '@shared/api'

/** A non-2xx answer from /api/app. `body.error` is the server's message; 409 means a business rule refused it. */
export class ApiError extends Error {
  status: number
  body: Partial<ApiErrorBody>
  constructor(status: number, body: Partial<ApiErrorBody>) {
    super(body.error ?? `HTTP ${status}`)
    this.status = status
    this.body = body
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/app${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (body && typeof body === 'object' ? body : {}) as ApiErrorBody)
  return body as T
}

// Network failures retry twice; an answer from the server (even a 500) is final.
const retry = (n: number, e: Error) => !(e instanceof ApiError) && n < 2

export const useDashboard = () => useQuery({ queryKey: ['dashboard'], queryFn: () => call<DashboardResponse>('/dashboard'), retry })

export const useOrders = (view: OrderView, q: string) =>
  useQuery({
    queryKey: ['orders', view, q],
    queryFn: () => call<OrdersListResponse>(`/orders?${new URLSearchParams({ view, ...(q ? { q } : {}) })}`),
    // Keep the previous rows on screen while the next search or view loads.
    placeholderData: (prev) => prev,
    retry,
  })

export const useOrder = (number: string) =>
  useQuery({ queryKey: ['order', number], queryFn: () => call<OrderDetailResponse>(`/orders/${encodeURIComponent(number)}`), retry })

// No optimistic updates: the server decides, then everything that shows the order is refetched.
function useInvalidate(number: string) {
  const qc = useQueryClient()
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['dashboard'] }),
    qc.invalidateQueries({ queryKey: ['orders'] }),
    qc.invalidateQueries({ queryKey: ['order', number] }),
  ])
}

export function useChangeProduction(number: string) {
  const invalidate = useInvalidate(number)
  return useMutation({
    mutationFn: (to: ProductionStatus) =>
      call<ProductionChangeResponse>(`/orders/${encodeURIComponent(number)}/production`, { method: 'PATCH', body: JSON.stringify({ to }) }),
    onSettled: invalidate,
  })
}

export function useChangePo(number: string) {
  const invalidate = useInvalidate(number)
  return useMutation({
    mutationFn: ({ poId, to }: { poId: number; to: PoStatus }) =>
      call<PoChangeResponse>(`/orders/${encodeURIComponent(number)}/purchase-orders/${poId}`, { method: 'PATCH', body: JSON.stringify({ to }) }),
    onSettled: invalidate,
  })
}
