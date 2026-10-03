/**
 * API client.
 *
 * Two things it handles that a bare `fetch` does not:
 *
 *  1. SILENT REFRESH. The access token lives 15 minutes. On a 401 the client
 *     refreshes once and replays the original request, so a clinician typing a
 *     note is never thrown back to the login screen mid-sentence. Concurrent
 *     401s share one refresh, rather than each firing their own and invalidating
 *     each other through the server's refresh-token rotation.
 *
 *  2. A TYPED ERROR. The API's error envelope carries a code, field issues and
 *     a request id; the UI needs all three — the code to decide what to render,
 *     the issues to mark up a form, the request id to quote to support.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
const API_PREFIX = '/api/v1';

export interface FieldIssue {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: FieldIssue[];
  readonly requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    issues: FieldIssue[] = [],
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.requestId = requestId;
  }

  /** Issues keyed by field, for marking up a form. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries(this.issues.map((i) => [i.field, i.message]));
  }
}

export interface ApiEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/* ---------------------------------------------------------------------------
 * Token storage
 *
 * The access token is held in memory only. localStorage would survive a tab
 * close on a shared workstation and is readable by any injected script; the
 * refresh token is an httpOnly cookie the browser handles, which is the point
 * of splitting them.
 * ------------------------------------------------------------------------- */

let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Listeners notified when the session ends, so the UI can redirect to login. */
const sessionEndedListeners = new Set<() => void>();

export function onSessionEnded(listener: () => void): () => void {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}

function notifySessionEnded(): void {
  accessToken = null;
  for (const listener of sessionEndedListeners) listener();
}

async function parseError(response: Response): Promise<ApiError> {
  let code = 'INTERNAL';
  let message = 'Something went wrong. Please try again.';
  let issues: FieldIssue[] = [];
  let requestId: string | undefined;

  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; issues?: FieldIssue[]; requestId?: string };
    };

    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      issues = body.error.issues ?? [];
      requestId = body.error.requestId;
    }
  } catch {
    // A non-JSON body (a proxy error page, say) leaves the defaults in place.
  }

  return new ApiError(response.status, code, message, issues, requestId);
}

/**
 * Refresh the access token. Concurrent callers share a single in-flight
 * request: the server rotates refresh tokens and revokes the family on reuse,
 * so two parallel refreshes would log the user out.
 */
async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${API_BASE}${API_PREFIX}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      if (!response.ok) return false;

      const body = (await response.json()) as { data?: { accessToken?: string } };
      if (!body.data?.accessToken) return false;

      accessToken = body.data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Internal: prevents an infinite refresh loop. */
  _retried?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_BASE}${API_PREFIX}${path}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
  const { method = 'GET', body, query, signal } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(buildUrl(path, query), {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    cache: 'no-store',
  });

  if (response.status === 401 && !options._retried) {
    // One refresh, then replay. If the refresh fails the session is genuinely
    // over and the UI is told, rather than looping.
    if (await refreshSession()) {
      return request<T>(path, { ...options, _retried: true });
    }

    notifySessionEnded();
    throw await parseError(response);
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  if (response.status === 204) {
    return { data: undefined as T };
  }

  return (await response.json()) as ApiEnvelope<T>;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    request<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/* ---------------------------------------------------------------------------
 * Domain types mirrored from the API responses
 * ------------------------------------------------------------------------- */

export type RoleKey =
  | 'platform_admin'
  | 'hospital_admin'
  | 'doctor'
  | 'nurse'
  | 'pharmacist'
  | 'lab_technician'
  | 'receptionist'
  | 'billing_clerk'
  | 'patient';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  roles: RoleKey[];
  permissions: string[];
  staffProfileId: string | null;
  patientId: string | null;
  mustChangePassword: boolean;
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
}

export interface PatientSummary {
  id: string;
  mrn: string;
  fullName: string;
  preferredName: string | null;
  dateOfBirth: string;
  age: number;
  sexAtBirth: string;
  status: string;
  primaryProviderName: string | null;
  phoneMasked: string | null;
  lastSeenAt: string | null;
  vipFlag: boolean;
}

export interface PatientDetail extends Omit<PatientSummary, 'phoneMasked'> {
  givenName: string;
  middleName: string | null;
  familyName: string;
  genderIdentity: string | null;
  pronouns: string | null;
  maritalStatus: string | null;
  bloodType: string | null;
  preferredLanguage: string;
  requiresInterpreter: boolean;
  nationalId: string | null;
  phone: string | null;
  altPhone: string | null;
  email: string | null;
  address: Record<string, string> | null;
  emergencyContact: Record<string, string> | null;
  primaryProviderId: string | null;
  photoUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClinicalSummary {
  allergies: Array<{ allergen: string; severity: string; reaction: string | null; kind: string }>;
  conditions: Array<{ code: string; display: string; status: string; onsetOn: string | null }>;
  latestVitals: Record<string, string | number | null> | null;
  openPrescriptions: number;
  outstandingBalanceCents: number;
}

export interface AppointmentListItem {
  id: string;
  reference: string;
  patientId: string;
  patientName: string;
  patientMrn: string;
  providerId: string;
  providerName: string;
  appointmentType: string;
  typeColour: string;
  startsAt: string;
  endsAt: string;
  status: string;
  modality: string;
  priority: string;
  room: string | null;
  reasonForVisit: string | null;
  checkedInAt: string | null;
}

export interface FreeSlot {
  providerId: string;
  providerName: string;
  facilityId: string | null;
  startsAt: string;
  endsAt: string;
  localTime: string;
  localDate: string;
  timezone: string;
  remainingCapacity: number;
  modality: string;
}

export interface StockStatusItem {
  itemId: string;
  locationId: string;
  sku: string;
  name: string;
  category: string;
  locationName: string;
  baseUnit: string;
  controlledSchedule: string | null;
  quantityOnHand: number;
  quantityAvailable: number;
  reorderLevel: number;
  criticalLevel: number;
  reorderQuantity: number;
  daysOfCover: number | null;
  stockState: 'ok' | 'low' | 'critical' | 'out_of_stock' | 'overstocked';
  earliestExpiry: string | null;
}

export interface DashboardMetrics {
  appointments_today: number;
  waiting_now: number;
  in_consultation: number;
  median_wait_minutes: number | null;
  active_patients: number;
  new_patients_30d: number;
  unsigned_notes_overdue: number;
  critical_results_unacknowledged: number;
  prescriptions_pending: number;
  stock_alerts_open: number;
  batches_expiring_30d: number;
  outstanding_balance_cents: number | null;
  collected_today_cents: number | null;
  claims_in_flight: number | null;
  claims_denied_30d: number | null;
  break_glass_pending_review: number;
  licences_expiring_soon: number;
}

export interface InvoiceListItem {
  id: string;
  invoice_number: string;
  issued_on: string;
  due_on: string | null;
  status: string;
  billing_stage: string;
  total_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  patient_name: string;
  mrn: string;
  payer_name: string | null;
  days_overdue: number;
}

export interface AgeingBucket {
  totalCents: number;
  count: number;
}
