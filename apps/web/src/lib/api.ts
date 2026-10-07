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

/* ---------------------------------------------------------------------------
 * Tenant, staff, clinical, pharmacy and reporting
 *
 * The reporting and worklist endpoints return database rows as they are, in
 * snake_case, rather than mapping each one into a camelCase DTO. That is a
 * deliberate line: a report is a projection whose shape belongs to the query,
 * and interposing a hand-maintained mapping layer over thirty aggregate
 * columns adds a place for them to drift without adding a guarantee. The
 * resource endpoints — patients, encounters, prescriptions — do map, because
 * those shapes are a contract other things depend on.
 *
 * Counts arrive as strings: PostgreSQL's count() is bigint, which exceeds
 * JavaScript's safe integer range, so node-postgres hands it over as text
 * rather than silently losing precision. Anything consuming one coerces it.
 * ------------------------------------------------------------------------- */

export interface TenantFacility {
  id: string;
  name: string;
  code: string;
  kind: string;
  timezone: string;
}

export interface TenantDepartment {
  id: string;
  name: string;
  code: string;
}

/**
 * A facility as the SETTINGS screen sees it: every column of the form, and the
 * closed ones too.
 *
 * Distinct from `TenantFacility`, which is the trimmed shape on `GET /tenant`
 * that feeds the booking, registration and stock pickers. That one is
 * active-only by design, so administration cannot reuse it — there would be no
 * way to offer "reopen".
 */
export interface FacilityRecord {
  id: string;
  name: string;
  code: string;
  kind: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string;
  phone: string | null;
  /** NULL means "follow the hospital" rather than "unknown". */
  timezone: string | null;
  is_active: boolean;
  created_at: string;
  /** bigint, so pg hands it over as a string. */
  active_department_count: string;
}

export interface DepartmentRecord {
  id: string;
  name: string;
  code: string;
  description: string | null;
  /** NULL means the department spans the whole hospital. */
  facility_id: string | null;
  facility_name: string | null;
  facility_is_active: boolean | null;
  is_active: boolean;
  created_at: string;
  /** How many staff name this as their primary department. bigint -> string. */
  staff_count: string;
}

export interface TenantProfile {
  id: string;
  slug: string;
  display_name: string;
  legal_name: string;
  facility_code: string;
  timezone: string;
  locale: string;
  currency: string;
  subscription_tier: string;
  settings: Record<string, unknown>;
  branding: Record<string, unknown>;
  facilities: TenantFacility[] | null;
  departments: TenantDepartment[] | null;
}

export interface EncounterWorklistItem {
  id: string;
  reference: string;
  started_at: string;
  ended_at: string | null;
  encounter_class: string;
  status: 'draft' | 'in_progress' | 'pending_signature' | 'signed' | 'amended' | 'voided';
  chief_complaint: string | null;
  signed_at: string | null;
  requires_cosign: boolean;
  cosigned_at: string | null;
  disposition: string | null;
  follow_up_in_days: number | null;
  diagnosis_count: number;
  patient_id: string;
  patient_name: string;
  mrn: string;
  provider_name: string;
  department_name: string | null;
  amendment_count: string;
  worst_news2: number | null;
  age_hours: string;
}

export interface PrescriptionLine {
  id: string;
  medicationName: string;
  strength: string | null;
  route: string;
  instructions: string;
  quantityPrescribed: string;
  quantityDispensed: string;
  status: string;
  controlledSchedule: string | null;
}

export interface DispenseQueueItem {
  id: string;
  reference: string;
  prescribed_at: string;
  status: string;
  patient_name: string;
  mrn: string;
  prescriber_name: string;
  lines_outstanding: string;
  has_controlled: boolean;
  needs_cold_chain: boolean;
  /** Only the lines still to be picked, so the row reads as remaining work. */
  outstanding_items: PrescriptionLine[];
}

export interface StaffMember {
  id: string;
  staff_number: string;
  display_name: string;
  title: string | null;
  given_name: string;
  family_name: string;
  is_provider: boolean;
  specialties: string[] | null;
  employment_type: string;
  is_active: boolean;
  license_expires_on: string | null;
  default_slot_minutes: number;
  accepts_new_patients: boolean;
  department_name: string | null;
  facility_name: string | null;
  email: string | null;
  account_status: string | null;
  last_login_at: string | null;
  roles: RoleKey[] | null;
  licence_expiring_soon: boolean;
}

export interface UtilisationRow {
  provider_id: string;
  display_name: string;
  department: string | null;
  booked: string;
  completed: string;
  no_shows: string;
  cancelled: string;
  no_show_rate_pct: string | null;
  avg_slot_minutes: string | null;
  avg_actual_minutes: string | null;
}

export interface RevenueReport {
  byPayer: Array<{
    payer: string;
    invoices: string;
    billed_cents: string | null;
    collected_cents: string | null;
    outstanding_cents: string | null;
    collection_rate_pct: string | null;
  }>;
  byServiceCategory: Array<{ category: string | null; net_cents: string | null; units: string | null }>;
  topDenialReasons: Array<{
    denial_code: string | null;
    description: string | null;
    occurrences: string;
    denied_cents: string | null;
  }>;
  collectionsByMethod: Array<{ method: string; payments: string; total_cents: string | null }>;
}

export interface BreakGlassGrant {
  id: string;
  created_at: string;
  expires_at: string;
  justification: string;
  accessed_by: string;
  email: string;
  patient_name: string;
  mrn: string;
  reviewed_at: string | null;
  review_outcome: string | null;
  actions_taken: string;
}

export interface AppointmentType {
  id: string;
  code: string;
  name: string;
  duration_minutes: number;
  buffer_after_minutes: number;
  modality: string;
  colour: string;
  base_price_cents: number;
  min_notice_hours: number;
  max_advance_days: number;
  patient_bookable: boolean;
  requires_referral: boolean;
  department_id: string | null;
  department_name: string | null;
}

export interface VitalsReading {
  id: string;
  recorded_at: string;
  temperature_c: string | null;
  heart_rate_bpm: number | null;
  respiratory_rate: number | null;
  systolic_mmhg: number | null;
  diastolic_mmhg: number | null;
  oxygen_saturation: string | null;
  blood_glucose_mmol: string | null;
  weight_kg: string | null;
  height_cm: string | null;
  bmi: string | null;
  pain_score: number | null;
  news2_score: number | null;
  recorded_by_name: string | null;
}

export interface CodedTerm {
  system: string;
  code: string;
  display: string;
}

export interface EncounterDetail {
  id: string;
  reference: string;
  patientId: string;
  patientName: string;
  mrn: string;
  dateOfBirth: string;
  sexAtBirth: string;
  appointmentId: string | null;
  providerId: string;
  providerName: string;
  departmentName: string | null;
  encounterClass: string;
  startedAt: string;
  endedAt: string | null;
  chiefComplaint: string | null;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  diagnosisCodes: CodedTerm[];
  procedureCodes: CodedTerm[];
  followUpInDays: number | null;
  disposition: string | null;
  status: 'draft' | 'in_progress' | 'pending_signature' | 'signed' | 'amended' | 'voided';
  signedAt: string | null;
  signedByName: string | null;
  requiresCosign: boolean;
  cosignedAt: string | null;
  accessBasis: string;
  vitals: VitalsReading[];
  amendments: Array<{
    id: string;
    sequenceNo: number;
    createdAt: string;
    reason: string;
    amendedByName: string | null;
    narrative: string | null;
  }>;
}

export interface FormularyItem {
  id: string;
  sku: string;
  name: string;
  generic_name: string | null;
  form: string | null;
  strength: string | null;
  route: string | null;
  base_unit: string;
  controlled_schedule: string | null;
  is_high_alert: boolean;
  is_medication: boolean;
  requires_prescription: boolean;
  requires_cold_chain: boolean;
  sale_price_cents: number | null;
  quantity_on_hand: string;
}

export interface SafetyWarning {
  severity: 'contraindicated' | 'severe' | 'moderate' | 'info';
  code: string;
  message: string;
  blocking: boolean;
}

export interface PrescriptionLineInput {
  itemId?: string;
  medicationName: string;
  strength?: string;
  form?: string;
  route: string;
  doseQuantity: number;
  doseUnit: string;
  frequencyCode: string;
  frequencyPerDay?: number;
  durationDays?: number;
  asNeeded: boolean;
  instructions: string;
  quantityPrescribed: number;
  refillsAuthorised: number;
  substitutionAllowed: boolean;
}

export interface InventoryLocation {
  id: string;
  name: string;
  code: string;
  kind: string;
  allows_controlled: boolean;
  temperature_controlled: boolean;
  facility_name: string | null;
  batches_available: string;
}

export interface StockAlert {
  id: string;
  alert_type: string;
  severity: string;
  message: string;
  status: string;
  created_at: string;
  quantity_at_alert: string | null;
  threshold: string | null;
  item_name: string;
  sku: string;
  reorder_quantity: string | null;
  location_name: string;
  preferred_supplier: string | null;
}

export interface ServiceItem {
  id: string;
  code: string;
  name: string;
  category: string;
  cpt_code: string | null;
  unit_price_cents: number;
  tax_rate: string;
  is_active: boolean;
}

export interface InvoiceDetail {
  id: string;
  invoice_number: string;
  patient_id: string;
  patient_name: string;
  mrn: string;
  encounter_id: string | null;
  appointment_id: string | null;
  currency: string;
  issued_on: string;
  due_on: string | null;
  status: string;
  billing_stage: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  notes: string | null;
  days_overdue: number;
  lines: Array<{
    id: string;
    line_no: number;
    description: string;
    cpt_code: string | null;
    quantity: string;
    unit_price_cents: number;
    discount_cents: number;
    gross_cents: number;
    net_cents: number;
    tax_cents: number;
    diagnosis_codes: string[] | null;
    category: string | null;
  }>;
  payments: Array<{
    id: string;
    receipt_number: string;
    amount_cents: number;
    allocated_cents: number;
    method: string;
    payer_kind: string;
    received_at: string;
    status: string;
  }>;
  claims: Array<{
    id: string;
    claim_number: string;
    status: string;
    claimed_cents: number;
    paid_cents: number | null;
    denied_cents: number | null;
    submitted_at: string | null;
    adjudicated_at: string | null;
    denial_codes: Array<{ code: string; description: string }> | null;
    payer_name: string | null;
  }>;
  policies: Array<{
    id: string;
    plan_name: string | null;
    precedence: number;
    member_number_last4: string | null;
    copay_cents: number | null;
    coinsurance_rate: string | null;
    verification_status: string;
    payer_name: string;
  }>;
}

export interface EncounterTimelineEntry {
  id: string;
  reference: string;
  startedAt: string;
  endedAt: string | null;
  encounterClass: string;
  status: string;
  chiefComplaint: string | null;
  providerName: string;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  diagnosisCodes: CodedTerm[];
  amendmentCount: number;
}

export interface PatientPrescription {
  id: string;
  reference: string;
  prescribed_at: string;
  status: string;
  valid_until: string | null;
  prescriber_name: string;
  items: Array<{
    medicationName: string;
    strength: string | null;
    route: string;
    instructions: string;
    quantityPrescribed: string;
    quantityDispensed: string;
    refillsAuthorised: number;
    refillsUsed: number;
    status: string;
  }>;
}

export interface AccessLogEntry {
  occurred_at: string;
  action: string;
  actor_label: string | null;
  actor_role: string | null;
  outcome: string;
  resource_type: string;
  access_basis: string | null;
  ip_address: string | null;
}

export interface AppNotification {
  id: string;
  category: string;
  priority: number;
  subject: string | null;
  body: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
  related_kind: string | null;
  related_id: string | null;
}
