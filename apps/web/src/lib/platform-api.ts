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
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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

export const platformApi = {
  get: <T>(path: string, query?: Options['query'], signal?: AbortSignal) =>
    request<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
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
