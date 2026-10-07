/**
 * API client for the vendor console.
 *
 * A separate module with a separate token store, rather than a flag on the
 * tenant client. The two credentials must never be attached to the same
 * request, and the cheapest way to guarantee that is for neither client to
 * be able to see the other's token: `api` cannot reach `platformToken`, and
 * this cannot reach the tenant one.
 *
 * It also means an operator can hold both sessions in one browser — signed
 * into the console and into a test hospital — without either silently
 * clobbering the other.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
const API_PREFIX = '/api/v1/platform';

import { ApiError, type ApiEnvelope, type FieldIssue } from './api';

export { ApiError };

/** In memory only, exactly as the tenant token is, and for the same reason. */
let platformToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export function setPlatformToken(token: string | null): void {
  platformToken = token;
}

const endedListeners = new Set<() => void>();

export function onPlatformSessionEnded(listener: () => void): () => void {
  endedListeners.add(listener);
  return () => endedListeners.delete(listener);
}

function notifyEnded(): void {
  platformToken = null;
  for (const listener of endedListeners) listener();
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
    // Non-JSON body; the defaults stand.
  }

  return new ApiError(response.status, code, message, issues, requestId);
}

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

      platformToken = body.data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  _retried?: boolean;
}

function buildUrl(path: string, query?: Options['query']): string {
  const url = new URL(`${API_BASE}${API_PREFIX}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function request<T>(path: string, options: Options = {}): Promise<ApiEnvelope<T>> {
  const { method = 'GET', body, query, signal } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (platformToken) headers.Authorization = `Bearer ${platformToken}`;

  const response = await fetch(buildUrl(path, query), {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    cache: 'no-store',
  });

  if (response.status === 401 && !options._retried) {
    if (await refreshSession()) {
      return request<T>(path, { ...options, _retried: true });
    }
    notifyEnded();
    throw await parseError(response);
  }

  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return { data: undefined as T };

  return (await response.json()) as ApiEnvelope<T>;
}

/**
 * Open an invoice PDF in a new tab.
 *
 * Fetched rather than linked: the console authenticates with a bearer token
 * held in memory, so a plain `<a href>` sends no Authorization header and
 * comes back 401. An earlier version of this WAS a plain link, and it did.
 */
export async function openPlatformInvoicePdf(invoiceId: string): Promise<void> {
  const response = await fetch(`${API_BASE}${API_PREFIX}/billing/invoices/${invoiceId}.pdf`, {
    headers: platformToken ? { Authorization: `Bearer ${platformToken}` } : {},
    credentials: 'include',
    cache: 'no-store',
  });

  if (!response.ok) throw await parseError(response);

  const objectUrl = URL.createObjectURL(await response.blob());
  window.open(objectUrl, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

export const platformApi = {
  get: <T>(path: string, query?: Options['query'], signal?: AbortSignal) =>
    request<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  refresh: refreshSession,
};

/* ---------------------------------------------------------------------------
 * Shapes
 * ------------------------------------------------------------------------- */

export interface Operator {
  operatorId: string;
  email: string;
  fullName: string;
  isOwner: boolean;
  sessionId: string;
}

export interface OperatorRow {
  id: string;
  email: string;
  full_name: string;
  status: 'invited' | 'active' | 'suspended';
  is_owner: boolean;
  last_login_at: string | null;
  created_at: string;
  invite_pending: boolean;
}

export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'archived';

export interface TenantRow {
  id: string;
  slug: string;
  display_name: string;
  legal_name: string;
  facility_code: string;
  timezone: string;
  locale: string;
  currency: string;
  status: TenantStatus;
  subscription_tier: 'trial' | 'standard' | 'enterprise';
  status_changed_at: string | null;
  status_reason: string | null;
  created_at: string;
  active_user_count: string;
  patient_count: string;
  facility_count: string;
  last_activity_at: string | null;
}

export interface TenantDetail extends TenantRow {
  provisioned_by_email: string | null;
  invited_user_count: string;
  department_count: string;
  unreviewed_break_glass: string;
}

export interface PlatformSummary {
  tenant_count: string;
  active_tenants: string;
  suspended_tenants: string;
  archived_tenants: string;
  trial_tenants: string;
  active_users: string;
  unreviewed_break_glass: string;
  active_operators: string;
  platform_actions_7d: string;
}

export interface AuditRow {
  id: string;
  occurred_at: string;
  action: string;
  outcome: string;
  resource_type: string;
  resource_id: string | null;
  actor_label: string | null;
  actor_role: string | null;
  ip_address: string | null;
  changes: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  by_platform: boolean;
  touched_phi: boolean;
  tenant_slug: string | null;
  tenant_name: string | null;
}

export interface BreakGlassRow {
  id: string;
  created_at: string;
  expires_at: string;
  reviewed_at: string | null;
  review_outcome: string | null;
  justification_length: number;
  clinician_name: string | null;
  tenant_slug: string;
  tenant_name: string;
  still_active: boolean;
}

/* ---------------------------------------------------------------------------
 * Subscription billing
 *
 * Every amount is an integer of the currency's smallest unit, and every one
 * carries its own `currency` — the vendor may bill one hospital in TZS and
 * another in USD, and those scales differ. Render with
 * `formatMoney(amount, currency)`; never add two of these together without
 * checking they match.
 * ------------------------------------------------------------------------- */

export interface PlanRow {
  id: string;
  tier: 'trial' | 'standard' | 'enterprise';
  currency: string;
  amount_cents: string;
  billing_interval: 'month' | 'year';
  payment_terms_days: number;
  description: string | null;
  is_active: boolean;
  updated_at: string;
}

export interface DueRow {
  tenant_id: string;
  display_name: string;
  slug: string;
  tier: string;
  currency: string;
  amount_cents: string;
  current_period_end: string;
  periods_due: number;
}

export interface SubscriptionRow {
  tenant_id: string;
  tier: string;
  currency: string;
  billing_interval: 'month' | 'year';
  /** NULL means "follow the price book". A number is a negotiated rate. */
  override_cents: string | null;
  override_terms_days: number | null;
  effective_amount_cents: string | null;
  has_negotiated_rate: boolean;
  current_period_start: string;
  current_period_end: string;
  trial_ends_on: string | null;
  status: 'trialing' | 'active' | 'cancelled';
  cancelled_on: string | null;
  notes: string | null;
  invoice_count: string;
  outstanding_cents: string;
  overdue_cents: string;
}

export interface SubscriptionPaymentRow {
  id: string;
  amount_cents: string;
  currency: string;
  received_on: string;
  method: string;
  reference: string | null;
  notes: string | null;
  voided_at: string | null;
  void_reason: string | null;
  recorded_by_email: string | null;
  created_at: string;
}

export interface SubscriptionInvoiceRow {
  id: string;
  invoice_number: string;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  tenant_status?: string;
  tier: string;
  period_start: string;
  period_end: string;
  currency: string;
  amount_cents: string;
  tax_cents: string;
  total_cents: string;
  amount_paid_cents: string;
  balance_cents: string;
  status: 'issued' | 'partially_paid' | 'paid' | 'void';
  /** Derived from today's date, never stored. */
  is_overdue: boolean;
  days_overdue: number;
  issued_on: string;
  due_on: string;
  void_reason: string | null;
  notes: string | null;
  issued_by_email?: string | null;
  payments?: SubscriptionPaymentRow[];
}

export interface RevenueRow {
  currency: string;
  active_subscriptions: string;
  trialing: string;
  /** Monthly recurring revenue, with annual plans divided by twelve. */
  mrr_cents: string;
  outstanding_cents: string;
  overdue_cents: string;
  overdue_invoice_count: string;
}

export interface BillingRunResult {
  issued: Array<{ tenantName: string; invoiceNumber: string; totalCents: number; currency: string }>;
  skipped: Array<{ tenantName: string; reason: string }>;
}
