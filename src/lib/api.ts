import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CheckClearRequest, CheckCollectRequest, CheckCreateRequest, CheckDepositRequest, CheckReadyRequest, CheckWriteResponse, CollectPickupRequest,
  NotifyPickupRequest, PaymentsPageResponse, PaymentsResponse, PickupResponse, RecordPaymentRequest, RecordPaymentResponse, VoidPaymentRequest,
} from '@shared/api'
import type {
  ArtworkListResponse, UploadResponse, CustomerDetailResponse, CustomersListResponse, DashboardResponse, OrderDetailResponse, OrdersListResponse, OrderView, PoChangeResponse, ProductionChangeResponse,
  OrderWriteResponse, PrepRequest, PurchaseCreateRequest, PurchaseOrderedRequest, PurchasePatchRequest, PurchasesResponse, ReasonRequest, ReceiptCreateRequest,
  SupplierCreateRequest, SupplierResponse, SuppliersResponse,
  ProductionChangeRequest, ProductionResponse, QueueReorderRequest, QueueReorderResponse, UnitsRequest,
} from '@shared/api'
import type { CustomerKind, PoStatus, ProductionStatus, Role } from '@shared/enums'
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

export const isConflict = (e: unknown) => e instanceof ApiError && e.status === 409 && e.body.code === 'conflict_retry'

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
    qc.invalidateQueries({ queryKey: ['production'] }),
    qc.invalidateQueries({ queryKey: ['payments'] }),
    qc.invalidateQueries({ queryKey: ['orders'] }),
    qc.invalidateQueries({ queryKey: ['order', number] }),
  ])
}

export function useChangeProduction(number: string, expectedVersion: number) {
  const invalidate = useInvalidate(number)
  return useMutation({
    mutationFn: (to: ProductionStatus) =>
      call<ProductionChangeResponse>(`/orders/${encodeURIComponent(number)}/production`, { method: 'PATCH', body: JSON.stringify({ to, expectedVersion }) }),
    onSettled: invalidate,
  })
}

// expectedVersion is the order version the page was opened with, so a stale page gets 409 conflict_retry.
export function useChangePo(number: string, expectedVersion: number) {
  const invalidate = useInvalidate(number)
  return useMutation({
    mutationFn: ({ poId, to }: { poId: number; to: PoStatus }) =>
      call<PoChangeResponse>(`/orders/${encodeURIComponent(number)}/purchase-orders/${poId}`, { method: 'PATCH', body: JSON.stringify({ to, expectedVersion }) }),
    onSettled: invalidate,
  })
}

export const useCustomers = (q: string, kind: CustomerKind | '', enabled = true) =>
  useQuery({
    queryKey: ['customers', q, kind],
    queryFn: () => call<CustomersListResponse>(`/customers?${new URLSearchParams({ ...(q ? { q } : {}), ...(kind ? { kind } : {}), limit: '50' })}`),
    placeholderData: (prev) => prev,
    enabled,
    retry,
  })

export const useCustomer = (id: number | null) =>
  useQuery({ queryKey: ['customer', id], queryFn: () => call<CustomerDetailResponse>(`/customers/${id}`), enabled: id !== null, retry })

/** Owner-only on the server: a 403 simply means no assignee list. */
export const useUsers = () =>
  useQuery({ queryKey: ['users'], queryFn: () => call<{ users: { id: number; name: string }[] }>('/users'), retry: false, staleTime: 60_000 })

/** A write: `send('POST', '/orders', body)`. Returns the parsed answer, or throws ApiError. */
export const send = <T = unknown>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
  call<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

/**
 * Every write refetches whatever is on screen afterwards (success or a 409), so a conflict shows the
 * server's current state next to the translated notice. No optimistic updates.
 */
export function useSend<T, V>(fn: (v: V) => Promise<T>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries() })
}

// ---- uploads ----
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', tif: 'image/tiff', tiff: 'image/tiff', pdf: 'application/pdf', svg: 'image/svg+xml',
}
const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

/** The browser's type for the file, or one inferred from the extension when it is empty or generic. The server sniffs the bytes anyway. */
export function fileMime(file: File) {
  return file.type && file.type !== 'application/octet-stream' ? file.type : (EXT_MIME[extOf(file.name)] ?? file.type)
}

/** Client-side pre-check; the server re-checks everything. */
export function checkUpload(file: File, allowSvg: boolean): 'bad_type' | 'too_large' | null {
  const ext = extOf(file.name)
  if (!(ext in EXT_MIME) || (!allowSvg && ext === 'svg')) return 'bad_type'
  return file.size > MAX_UPLOAD_BYTES ? 'too_large' : null
}

/** POST the raw file (not multipart) to `/api/app${path}`; other fields go in the query string. Throws ApiError like every write. */
export async function uploadFile<T = UploadResponse>(path: string, file: File, query: Record<string, string | number | undefined>): Promise<T> {
  const qs = new URLSearchParams(Object.entries(query).flatMap(([k, v]) => (v === undefined || v === '' ? [] : [[k, String(v)]])))
  const res = await fetch(`/api/app${path}?${qs}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': fileMime(file), 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  })
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (body && typeof body === 'object' ? body : {}) as ApiErrorBody)
  return body as T
}

export const useCustomerArtwork = (id: number) =>
  useQuery({ queryKey: ['customer', id, 'artwork'], queryFn: () => call<ArtworkListResponse>(`/customers/${id}/artwork`), retry })

export const fileUrl = (id: number, download = false) => `/api/app/files/${id}${download ? '?download=1' : ''}`

// ---- purchasing and prep (M3) ----
export const useSuppliers = () => useQuery({ queryKey: ['suppliers'], queryFn: () => call<SuppliersResponse>('/suppliers'), retry, staleTime: 60_000 })

/** Under ['order', number], so every order write's invalidation refetches it too. */
export const usePurchases = (number: string) =>
  useQuery({ queryKey: ['order', number, 'purchases'], queryFn: () => call<PurchasesResponse>(`/orders/${encodeURIComponent(number)}/purchases`), retry })

export function useCreateSupplier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SupplierCreateRequest) => send<SupplierResponse>('POST', '/suppliers', body),
    onSettled: () => qc.invalidateQueries({ queryKey: ['suppliers'] }),
  })
}

// The purchase, receipt and prep writes. Each body carries the order version the page was opened with
// (expectedVersion), so a stale page gets 409 conflict_retry; the order, its purchases and readiness are refetched after.
function useOrderWrite<V, T = OrderWriteResponse>(number: string, fn: (path: string, v: V) => Promise<T>) {
  const invalidate = useInvalidate(number)
  return useMutation({ mutationFn: (v: V) => fn(`/orders/${encodeURIComponent(number)}`, v), onSettled: invalidate })
}
export const useCreatePurchase = (number: string) =>
  useOrderWrite(number, (base, b: PurchaseCreateRequest) => send<UploadResponse>('POST', `${base}/purchases`, b))
export const useUpdatePurchase = (number: string) =>
  useOrderWrite(number, (base, { id, ...b }: PurchasePatchRequest & { id: number }) => send<OrderWriteResponse>('PATCH', `${base}/purchases/${id}`, b))
export const useMarkPurchaseOrdered = (number: string) =>
  useOrderWrite(number, (base, { id, ...b }: PurchaseOrderedRequest & { id: number }) => send<OrderWriteResponse>('POST', `${base}/purchases/${id}/ordered`, b))
export const useCancelPurchase = (number: string) =>
  useOrderWrite(number, (base, { id, ...b }: ReasonRequest & { id: number }) => send<OrderWriteResponse>('POST', `${base}/purchases/${id}/cancel`, b))
export const useRecordReceipt = (number: string) =>
  useOrderWrite(number, (base, { id, ...b }: ReceiptCreateRequest & { id: number }) => send<UploadResponse>('POST', `${base}/purchases/${id}/receipts`, b))
export const useChangePrep = (number: string) =>
  useOrderWrite(number, (base, b: PrepRequest) => send<OrderWriteResponse>('PATCH', `${base}/prep`, b))

// ---- production (M4) ----
// Every production write sends the order version the page or queue row was loaded with (expectedVersion); a 409 comes
// back as ApiError with body.code production_busy (body.runningJob names the running order), no_slot_available,
// conflict_retry, gate_failed or transition_not_allowed. Dashboard, production, orders and the order are refetched after.
export const useProduction = () => useQuery({ queryKey: ['production'], queryFn: () => call<ProductionResponse>('/production'), retry })

/** Start (or restart after QC) = to 'in_production'; an owner override adds { override: true, reason }. */
export const useStartProduction = (number: string) =>
  useOrderWrite(number, (base, b: Omit<ProductionChangeRequest, 'to'>) => send<ProductionChangeResponse>('PATCH', `${base}/production`, { ...b, to: 'in_production' }))
/** Every other move: to quality_control, production_complete, or back to readiness's preProductionStatus (pause). */
export const useMoveProduction = (number: string) =>
  useOrderWrite(number, (base, b: Pick<ProductionChangeRequest, 'to' | 'expectedVersion'>) => send<ProductionChangeResponse>('PATCH', `${base}/production`, b))
export const useUnitsCompleted = (number: string) =>
  useOrderWrite(number, (base, b: UnitsRequest) => send<OrderWriteResponse>('PATCH', `${base}/units`, b))

/** seen = the Ready to start numbers as shown; orderNumbers = the same numbers in the new order. 409 conflict_retry when the queue moved. */
export function useReorderQueue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: QueueReorderRequest) => send<QueueReorderResponse>('POST', '/production/queue', b),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ['production'] }), qc.invalidateQueries({ queryKey: ['dashboard'] })]),
  })
}

// ---- pickup and payments (M5) ----
// Order writes send the order version the page was loaded with (expectedVersion; 409 conflict_retry when stale). The
// check moves (ready, collect, deposit, clear) need no version: the server guards them by the check's status.
// Pickup and payment queries live under ['order', number], so every order write's invalidation refetches them.
export const usePickup = (number: string) =>
  useQuery({ queryKey: ['order', number, 'pickup'], queryFn: () => call<PickupResponse>(`/orders/${encodeURIComponent(number)}/pickup`), retry })
export const useNotifyPickup = (number: string) =>
  useOrderWrite(number, (base, b: NotifyPickupRequest) => send<OrderWriteResponse>('POST', `${base}/pickup/notify`, b))
/** 409 payment_required means show the unpaid warning; an owner resends with { override: true, reason }. */
export const useCollectPickup = (number: string) =>
  useOrderWrite(number, (base, b: CollectPickupRequest) => send<OrderWriteResponse>('POST', `${base}/pickup/collect`, b))

export const usePayments = (number: string) =>
  useQuery({ queryKey: ['order', number, 'payments'], queryFn: () => call<PaymentsResponse>(`/orders/${encodeURIComponent(number)}/payments`), retry })

/**
 * One requestId per form submission: made on the first attempt and reused while that same submission is retried after a
 * failure (network error, double click), so the server records it once. A success, or any change to the details, starts
 * a new submission, so two identical payments entered one after the other are both recorded. newSubmission() forces one.
 */
/** Unresolved submissions live at module level, by order, so closing and reopening the dialog (or using the Payments page) keeps the retry identity. */
const pendingPayments = new Map<string, { key: string; requestId: string }>()
export function useRecordPayment(number: string) {
  const submission = {
    get current() { return pendingPayments.get(number) ?? null },
    set current(v: { key: string; requestId: string } | null) { if (v) pendingPayments.set(number, v); else pendingPayments.delete(number) },
  }
  const write = useOrderWrite(number, async (base, b: RecordPaymentRequest) => {
    const res = await send<RecordPaymentResponse>('POST', `${base}/payments`, b)
    if (submission.current?.requestId === b.requestId) submission.current = null
    return res
  })
  const requestIdFor = (b: Omit<RecordPaymentRequest, 'requestId'>) => {
    // The same submission = the same details; anything changed in the form is a new submission with a new id.
    const key = JSON.stringify([b.amountCents, b.method, b.paidOn ?? null, b.notes ?? null])
    if (submission.current?.key !== key) submission.current = { key, requestId: crypto.randomUUID() }
    return submission.current.requestId
  }
  return {
    ...write,
    mutate: (b: Omit<RecordPaymentRequest, 'requestId'>) => write.mutate({ ...b, requestId: requestIdFor(b) }),
    mutateAsync: (b: Omit<RecordPaymentRequest, 'requestId'>) => write.mutateAsync({ ...b, requestId: requestIdFor(b) }),
    newSubmission: () => { submission.current = null },
  }
}
/** Owner only (403 void_requires_owner). */
export const useVoidPayment = (number: string) =>
  useOrderWrite(number, (base, { id, ...b }: VoidPaymentRequest & { id: number }) => send<OrderWriteResponse>('POST', `${base}/payments/${id}/void`, b))
export const useCreateCheck = (number: string) =>
  useOrderWrite(number, (base, b: CheckCreateRequest) => send<CheckWriteResponse>('POST', `${base}/checks`, b))

/** Check moves refetch everything on screen (order, payments page, dashboard): they are reached from all three. */
const useCheckMove = <V>(move: 'ready' | 'collect' | 'deposit' | 'clear') =>
  useSend(({ id, ...b }: V & { id: number }) => send<CheckWriteResponse>('POST', `/checks/${id}/${move}`, b))
export const useCheckReady = () => useCheckMove<CheckReadyRequest>('ready')
/** Safe to retry: the same amount answers with the stored collection; a different one is 409 check_collect_conflict. */
export const useCollectCheck = () => useCheckMove<CheckCollectRequest>('collect')
export const useDepositCheck = () => useCheckMove<CheckDepositRequest>('deposit')
export const useClearCheck = () => useCheckMove<CheckClearRequest>('clear')

export const usePaymentsPage = () => useQuery({ queryKey: ['payments'], queryFn: () => call<PaymentsPageResponse>('/payments'), retry })

/** The signed-in user; `role` decides what the UI offers (the server enforces it regardless). */
export const useMe = () =>
  useQuery({ queryKey: ['me'], queryFn: () => call<{ id: number; email: string; name: string; role: Role }>('/me'), retry, staleTime: 5 * 60_000 })

