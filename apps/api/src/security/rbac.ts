/**
 * Role-Based Access Control.
 *
 * Two layers, and both matter:
 *
 *   1. PERMISSION  — "may this role do this kind of thing at all?"
 *      A receptionist cannot sign a clinical note, whoever the patient is.
 *      Evaluated from the permission set stamped into the access token.
 *
 *   2. RELATIONSHIP — "may this person do it to THIS patient?"
 *      HIPAA's minimum-necessary rule (§164.502(b)). A doctor holding
 *      `encounter:write` still has no business in the chart of a patient they
 *      are not treating. Checked against the care team, with a break-glass
 *      escape hatch that is logged and reviewed.
 *
 * Systems that implement only layer 1 are the reason "nurse looked up a
 * celebrity's chart" keeps making the news.
 */
import type { Queryable } from '../db/pool.js';
import { ForbiddenError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export const ROLE_KEYS = [
  'platform_admin',
  'hospital_admin',
  'doctor',
  'nurse',
  'pharmacist',
  'lab_technician',
  'receptionist',
  'billing_clerk',
  'patient',
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

export const PERMISSIONS = [
  'patient:read', 'patient:write', 'patient:delete', 'patient:export', 'patient:merge',
  'appointment:read', 'appointment:write', 'appointment:checkin',
  'schedule:manage',
  'encounter:read', 'encounter:write', 'encounter:sign',
  'vitals:write',
  'prescription:read', 'prescription:write', 'prescription:dispense',
  'lab_order:read', 'lab_order:write', 'lab_result:write',
  'invoice:read', 'invoice:write', 'payment:write',
  'claim:read', 'claim:write',
  'inventory:read', 'inventory:write', 'inventory:purchase',
  'staff:read', 'staff:write', 'role:manage',
  'report:clinical', 'report:financial', 'report:operational',
  'audit:read', 'tenant:settings',
  'portal:self_read', 'portal:self_booking',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions that reach protected health information. A grant alone is not
 * enough for these: the relationship check below also has to pass.
 */
export const PHI_PERMISSIONS = new Set<Permission>([
  'patient:read', 'patient:write', 'patient:export', 'patient:merge',
  'appointment:read', 'appointment:write', 'appointment:checkin',
  'encounter:read', 'encounter:write', 'encounter:sign',
  'vitals:write',
  'prescription:read', 'prescription:write', 'prescription:dispense',
  'lab_order:read', 'lab_order:write', 'lab_result:write',
  'invoice:read', 'invoice:write', 'claim:read', 'claim:write',
  'report:clinical', 'audit:read',
  'portal:self_read', 'portal:self_booking',
]);

/** Lower rank = more authority. Nobody may grant a role outranking their own. */
export const ROLE_RANKS: Record<RoleKey, number> = {
  platform_admin: 0,
  hospital_admin: 10,
  doctor: 20,
  nurse: 30,
  pharmacist: 35,
  lab_technician: 40,
  receptionist: 50,
  billing_clerk: 55,
  patient: 90,
};

/** The authenticated caller, assembled by the authenticate middleware. */
export interface Principal {
  userId: string;
  tenantId: string;
  email: string;
  fullName: string;
  roles: RoleKey[];
  permissions: Set<Permission>;
  /** Present when the user is a clinician; links them to the care team. */
  staffProfileId: string | null;
  /** Present when the user is a patient-portal account. */
  patientId: string | null;
  sessionId: string;
  /** Facility-scoped grants; empty means tenant-wide. */
  facilityIds: string[];
}

export function hasPermission(principal: Principal, permission: Permission): boolean {
  return principal.permissions.has(permission);
}

export function hasAnyPermission(principal: Principal, permissions: Permission[]): boolean {
  return permissions.some((p) => principal.permissions.has(p));
}

export function hasRole(principal: Principal, role: RoleKey): boolean {
  return principal.roles.includes(role);
}

export function highestRank(principal: Principal): number {
  return Math.min(...principal.roles.map((r) => ROLE_RANKS[r] ?? 999));
}

/**
 * Guard a role assignment. Without this, a hospital admin could grant
 * platform_admin, or a receptionist could promote themselves.
 */
export function assertCanGrantRole(principal: Principal, targetRole: RoleKey): void {
  if (!hasPermission(principal, 'staff:write') && !hasPermission(principal, 'role:manage')) {
    throw new ForbiddenError('You cannot change role assignments.');
  }

  const targetRank = ROLE_RANKS[targetRole] ?? 999;
  if (targetRank < highestRank(principal)) {
    throw new ForbiddenError(
      'You cannot grant a role with more authority than your own.',
      { targetRole, actorRank: highestRank(principal) },
    );
  }

  if (targetRole === 'platform_admin') {
    throw new ForbiddenError('Platform administrator cannot be granted from within a hospital.');
  }
}

/* ---------------------------------------------------------------------------
 * Layer 2: relationship to the patient
 * ------------------------------------------------------------------------- */

export type AccessBasis =
  | 'self'                 // the patient, in the portal
  | 'care_team'            // named on the care team
  | 'treating_provider'    // the patient's primary provider
  | 'appointment'          // has an appointment with them today
  | 'administrative'       // front desk / billing: demographics and money only
  | 'break_glass'          // emergency override, logged and reviewed
  | 'denied';

export interface AccessDecision {
  allowed: boolean;
  basis: AccessBasis;
  /** True when the decision needs a prominent audit entry and a later review. */
  requiresReview: boolean;
}

/**
 * Decide whether `principal` may reach `patientId`, and on what grounds.
 *
 * The basis is returned rather than a bare boolean because the audit entry has
 * to record WHY access was granted. "Dr. Okafor read this chart" is not an
 * answer in an investigation; "as the named treating provider" is.
 */
export async function resolvePatientAccess(
  db: Queryable,
  principal: Principal,
  patientId: string,
): Promise<AccessDecision> {
  // A portal user reaches exactly one chart: their own.
  if (principal.patientId) {
    return principal.patientId === patientId
      ? { allowed: true, basis: 'self', requiresReview: false }
      : { allowed: false, basis: 'denied', requiresReview: false };
  }

  // Administrative roles work from demographics and billing, which they need
  // for every patient who walks in. They hold no clinical permissions, so the
  // permission layer already keeps them out of the notes.
  const isClinical = hasAnyPermission(principal, [
    'encounter:read', 'encounter:write', 'prescription:write', 'lab_result:write',
  ]);

  if (!isClinical) {
    return { allowed: true, basis: 'administrative', requiresReview: false };
  }

  // Clinicians need a documented relationship.
  if (principal.staffProfileId) {
    const { rows } = await db.query<{ basis: string }>(
      `
      SELECT 'care_team' AS basis
        FROM care_team_members
       WHERE patient_id = $1 AND staff_profile_id = $2 AND ended_at IS NULL
      UNION ALL
      SELECT 'treating_provider'
        FROM patients
       WHERE id = $1 AND primary_provider_id = $2
      UNION ALL
      SELECT 'appointment'
        FROM appointments
       WHERE patient_id = $1 AND provider_id = $2
         AND starts_at BETWEEN now() - interval '1 day' AND now() + interval '30 days'
         AND status NOT IN ('cancelled','no_show')
      LIMIT 1
      `,
      [patientId, principal.staffProfileId],
    );

    const basis = rows[0]?.basis;
    if (basis) {
      return { allowed: true, basis: basis as AccessBasis, requiresReview: false };
    }
  }

  // No relationship. An active break-glass grant is the last legitimate route.
  const { rows: grants } = await db.query<{ id: string }>(
    `SELECT id FROM break_glass_grants
      WHERE user_id = $1 AND patient_id = $2 AND expires_at > now()
      LIMIT 1`,
    [principal.userId, patientId],
  );

  if (grants.length > 0) {
    logger.warn(
      { userId: principal.userId, patientId },
      'chart accessed under a break-glass grant',
    );
    return { allowed: true, basis: 'break_glass', requiresReview: true };
  }

  return { allowed: false, basis: 'denied', requiresReview: true };
}

/** Throwing wrapper for route handlers. */
export async function assertPatientAccess(
  db: Queryable,
  principal: Principal,
  patientId: string,
): Promise<AccessDecision> {
  const decision = await resolvePatientAccess(db, principal, patientId);

  if (!decision.allowed) {
    throw new ForbiddenError(
      'You are not part of this patient’s care team. Request emergency access if this is clinically urgent.',
      { patientId, userId: principal.userId },
    );
  }

  return decision;
}

/* ---------------------------------------------------------------------------
 * Permission resolution from the database
 * ------------------------------------------------------------------------- */

export interface ResolvedGrants {
  roles: RoleKey[];
  permissions: Permission[];
  facilityIds: string[];
}

/**
 * Read a user's effective roles and permissions.
 *
 * Called at login to build the token, and again on any request whose token is
 * older than the cache TTL, so that revoking a role takes effect promptly
 * rather than at the end of the token's lifetime.
 */
export async function loadUserGrants(db: Queryable, userId: string): Promise<ResolvedGrants> {
  const { rows } = await db.query<{
    role_key: RoleKey;
    permission_key: Permission | null;
    facility_id: string | null;
  }>(
    `
    SELECT r.key AS role_key, rp.permission_key, ur.facility_id
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
     WHERE ur.user_id = $1
       AND (ur.expires_at IS NULL OR ur.expires_at > now())
    `,
    [userId],
  );

  const roles = new Set<RoleKey>();
  const permissions = new Set<Permission>();
  const facilityIds = new Set<string>();

  for (const row of rows) {
    roles.add(row.role_key);
    if (row.permission_key) permissions.add(row.permission_key);
    if (row.facility_id) facilityIds.add(row.facility_id);
  }

  return {
    roles: [...roles],
    permissions: [...permissions],
    facilityIds: [...facilityIds],
  };
}
