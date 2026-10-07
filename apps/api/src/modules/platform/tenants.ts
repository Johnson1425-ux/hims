/**
 * Tenant provisioning and lifecycle.
 *
 * This is the half of the console that did not exist in any form: a hospital
 * could only be created by `pnpm db:seed`, and `tenants.status` — which the
 * login path has always honoured — had nothing that could move it off
 * 'active'. A working switch with no hand on it.
 *
 * PROVISIONING IS ONE TRANSACTION, and it has to be. A tenant row without its
 * data encryption key is a hospital whose encrypted columns can never be
 * read; one without a facility cannot register a patient; one without an
 * administrator cannot be got into at all except by a vendor operator
 * reaching into it, which is the thing this console exists to keep rare.
 * Any of those halfway states would need a human to clean up by hand, in the
 * schema where mistakes are least recoverable. So: all of it, or none.
 */
import type { Queryable } from '../../db/pool.js';
import { withoutTenantIsolation } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';
import { generateTenantDataKey, randomToken, sha256 } from '../../security/crypto.js';
import { env } from '../../config/env.js';
import type { PlatformPrincipal } from '../../middleware/authenticate-platform.js';
import { recordPlatformAction, type RequestMeta } from './service.js';
import type { z } from 'zod';
import type { provisionTenantSchema } from './schemas.js';

type ProvisionInput = z.infer<typeof provisionTenantSchema>;

/* ---------------------------------------------------------------------------
 * Reading
 * ------------------------------------------------------------------------- */

export interface ListTenantsInput {
  q?: string;
  status?: string;
  tier?: string;
  page: number;
  pageSize: number;
}

export async function listTenants(
  input: ListTenantsInput,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  return withoutTenantIsolation('platform console: listing hospitals', async (db) => {
    const filters: string[] = [];
    const params: unknown[] = [];

    if (input.q) {
      params.push(`%${input.q}%`);
      filters.push(
        `(t.display_name ILIKE $${params.length} OR t.legal_name ILIKE $${params.length} OR t.slug ILIKE $${params.length})`,
      );
    }
    if (input.status) {
      params.push(input.status);
      filters.push(`t.status = $${params.length}`);
    }
    if (input.tier) {
      params.push(input.tier);
      filters.push(`t.subscription_tier = $${params.length}`);
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const { rows: counts } = await db.query<{ total: string }>(
      `SELECT count(*) AS total FROM tenants t ${where}`,
      params,
    );

    params.push(input.pageSize, (input.page - 1) * input.pageSize);

    // Counts are scalar subqueries rather than joins so that a hospital with
    // no patients still appears, and so one busy tenant cannot fan the result
    // set out. These are vendor-side volume figures — row counts, never
    // content — which is the most this console has any business reading.
    const { rows } = await db.query(
      `SELECT t.id, t.slug, t.display_name, t.legal_name, t.facility_code,
              t.timezone, t.locale, t.currency, t.status, t.subscription_tier,
              t.status_changed_at, t.status_reason, t.created_at,
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.status = 'active')
                AS active_user_count,
              (SELECT count(*) FROM patients p WHERE p.tenant_id = t.id) AS patient_count,
              (SELECT count(*) FROM facilities f WHERE f.tenant_id = t.id AND f.is_active)
                AS facility_count,
              (SELECT max(a.occurred_at) FROM audit_events a WHERE a.tenant_id = t.id)
                AS last_activity_at
         FROM tenants t
         ${where}
        ORDER BY t.display_name
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows, total: Number(counts[0]!.total) };
  });
}

export async function getTenant(tenantId: string): Promise<Record<string, unknown> | null> {
  return withoutTenantIsolation('platform console: reading one hospital', async (db) => {
    const { rows } = await db.query(
      `SELECT t.id, t.slug, t.display_name, t.legal_name, t.facility_code,
              t.timezone, t.locale, t.currency, t.status, t.subscription_tier,
              t.status_changed_at, t.status_reason, t.created_at,
              p.email AS provisioned_by_email,
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.status = 'active')
                AS active_user_count,
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.status = 'invited')
                AS invited_user_count,
              (SELECT count(*) FROM patients pa WHERE pa.tenant_id = t.id) AS patient_count,
              (SELECT count(*) FROM facilities f WHERE f.tenant_id = t.id AND f.is_active)
                AS facility_count,
              (SELECT count(*) FROM departments d WHERE d.tenant_id = t.id AND d.is_active)
                AS department_count,
              (SELECT count(*) FROM break_glass_grants b
                WHERE b.tenant_id = t.id AND b.reviewed_at IS NULL) AS unreviewed_break_glass,
              (SELECT max(a.occurred_at) FROM audit_events a WHERE a.tenant_id = t.id)
                AS last_activity_at
         FROM tenants t
         LEFT JOIN platform_users p ON p.id = t.provisioned_by
        WHERE t.id = $1`,
      [tenantId],
    );

    return rows[0] ?? null;
  });
}

/* ---------------------------------------------------------------------------
 * Provisioning
 * ------------------------------------------------------------------------- */

async function assertFree(
  db: Queryable,
  column: 'slug' | 'facility_code',
  field: string,
  value: string,
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM tenants WHERE ${column} = $1`,
    [value],
  );

  if (rows.length > 0) {
    throw new AppError(409, 'CONFLICT', 'That identifier is already taken.', {
      issues: [{ field, message: `"${value}" is already in use by another hospital.` }],
    });
  }
}

export interface ProvisionResult {
  tenant: Record<string, unknown>;
  adminInviteUrl: string;
}

export async function provisionTenant(
  input: ProvisionInput,
  operator: PlatformPrincipal,
  meta: RequestMeta,
): Promise<ProvisionResult> {
  return withoutTenantIsolation('platform console: provisioning a hospital', async (db) => {
    await assertFree(db, 'slug', 'slug', input.slug);
    await assertFree(db, 'facility_code', 'facilityCode', input.facilityCode);

    const { rows: clashEmail } = await db.query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1',
      [input.adminEmail],
    );
    // Email is unique per tenant, not globally, so this is a warning case
    // rather than a conflict — the same person can administer two hospitals
    // and will be asked for their tenant at sign-in.
    const emailExistsElsewhere = clashEmail.length > 0;

    // The id is allocated first because the data encryption key is bound to
    // it: `generateTenantDataKey` mixes the tenant id into the AAD, so a
    // wrapped key cannot be lifted from one tenant's row and used in
    // another's. That ordering is load-bearing, not incidental.
    const { rows: ids } = await db.query<{ tenant_id: string; user_id: string; profile_id: string }>(
      'SELECT gen_random_uuid() AS tenant_id, gen_random_uuid() AS user_id, gen_random_uuid() AS profile_id',
    );
    const { tenant_id: tenantId, user_id: userId, profile_id: profileId } = ids[0]!;

    const dek = generateTenantDataKey(tenantId);

    const { rows: tenantRows } = await db.query(
      `INSERT INTO tenants (id, slug, legal_name, display_name, facility_code, timezone, locale,
                            currency, dek_wrapped, dek_key_version, subscription_tier,
                            status, status_changed_at, status_reason, provisioned_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', now(), 'Provisioned', $12)
       RETURNING id, slug, display_name, legal_name, facility_code, timezone, locale, currency,
                 status, subscription_tier, created_at`,
      [
        tenantId,
        input.slug,
        input.legalName,
        input.displayName,
        input.facilityCode,
        input.timezone,
        input.locale,
        input.currency,
        dek.wrapped,
        dek.keyVersion,
        input.subscriptionTier,
        operator.operatorId,
      ],
    );

    // Some triggers and helper functions read the request context rather than
    // taking a tenant argument. The role bypasses RLS, so this is for their
    // benefit, not for isolation.
    await db.query('SELECT hims_util.set_request_context($1, NULL, true)', [tenantId]);

    await db.query(
      `INSERT INTO facilities (tenant_id, name, code, kind, city, country, timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantId,
        input.facilityName,
        input.facilityCode,
        input.facilityKind,
        input.city ?? null,
        input.country,
        input.timezone,
      ],
    );

    // No password, exactly as `POST /staff` does it. An operator who sets a
    // hospital administrator's password can act as them, and the audit trail
    // would have no way to tell the two apart.
    await db.query(
      `INSERT INTO users (id, tenant_id, email, full_name, status, must_change_password)
       VALUES ($1, $2, $3, $4, 'invited', false)`,
      [userId, tenantId, input.adminEmail, input.adminFullName],
    );

    await db.query(
      `INSERT INTO staff_profiles (id, tenant_id, user_id, staff_number, given_name, family_name,
                                   employment_type, is_provider, hired_on)
       VALUES ($1, $2, $3, hims_util.allocate_reference($2, 'staff', 'STF'), $4, $5,
               'permanent', false, CURRENT_DATE)`,
      [profileId, tenantId, userId, input.adminGivenName, input.adminFamilyName],
    );

    // granted_by is NULL: no user granted this, the vendor did. The platform
    // audit row below is where that attribution lives.
    await db.query(
      `INSERT INTO user_roles (user_id, role_id, granted_by)
       SELECT $1, r.id, NULL FROM roles r
        WHERE r.key = 'hospital_admin' AND r.tenant_id IS NULL
        LIMIT 1`,
      [userId],
    );

    const inviteToken = randomToken(32);
    await db.query(
      `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
       VALUES ($1, 'invitation', $2, now() + interval '7 days')`,
      [userId, sha256(inviteToken)],
    );

    await recordPlatformAction(
      db,
      operator,
      {
        action: 'platform.tenant_provisioned',
        resourceType: 'tenant',
        resourceId: tenantId,
        tenantId,
        metadata: {
          slug: input.slug,
          tier: input.subscriptionTier,
          adminEmail: input.adminEmail,
          adminEmailExistsAtAnotherHospital: emailExistsElsewhere,
        },
      },
      meta,
    );

    return {
      tenant: tenantRows[0]!,
      adminInviteUrl: `${env.WEB_BASE_URL}/accept-invitation?token=${inviteToken}`,
    };
  });
}

/* ---------------------------------------------------------------------------
 * Lifecycle
 * ------------------------------------------------------------------------- */

/**
 * Move a hospital between 'active', 'suspended' and 'archived'.
 *
 * The login path has always refused a non-active tenant with
 * TENANT_SUSPENDED; this is what finally moves the column. Two things happen
 * besides the UPDATE:
 *
 *   - LIVE SESSIONS ARE REVOKED. Without that, suspension would only stop new
 *     sign-ins while everyone already working carried on for up to a week on
 *     their existing refresh token — which is not what anyone means by
 *     "suspend this hospital".
 *   - THE REASON IS RECORDED, against the tenant and in the audit trail. "Why
 *     can we not sign in" is the first question support is asked.
 */
export async function setTenantStatus(
  tenantId: string,
  status: 'active' | 'suspended' | 'archived',
  reason: string | undefined,
  operator: PlatformPrincipal,
  meta: RequestMeta,
): Promise<Record<string, unknown>> {
  if (status !== 'active' && !reason?.trim()) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Say why this hospital is being taken offline.', {
      issues: [
        {
          field: 'reason',
          message: 'A reason is required, and is shown to whoever asks support why they are locked out.',
        },
      ],
    });
  }

  return withoutTenantIsolation('platform console: changing a hospital’s status', async (db) => {
    const { rows: existing } = await db.query<{ id: string; status: string; slug: string }>(
      'SELECT id, status, slug FROM tenants WHERE id = $1 FOR UPDATE',
      [tenantId],
    );

    const tenant = existing[0];
    if (!tenant) throw new AppError(404, 'NOT_FOUND', 'That hospital could not be found.');

    // Archiving is the end of the line, and undoing it silently would make
    // "archived" meaningless as a retention state.
    if (tenant.status === 'archived' && status !== 'archived') {
      throw new AppError(
        409,
        'PRECONDITION_FAILED',
        'This hospital is archived. Restoring it is a data-retention decision and is not done from the console.',
      );
    }

    const { rows } = await db.query(
      `UPDATE tenants
          SET status = $2, status_changed_at = now(), status_reason = $3
        WHERE id = $1
       RETURNING id, slug, display_name, status, status_changed_at, status_reason, subscription_tier`,
      [tenantId, status, reason?.trim() ?? null],
    );

    if (status !== 'active') {
      const { rows: revoked } = await db.query<{ count: string }>(
        `WITH ended AS (
           UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'tenant_' || $2
            WHERE tenant_id = $1 AND revoked_at IS NULL
            RETURNING 1
         )
         SELECT count(*) AS count FROM ended`,
        [tenantId, status],
      );

      await recordPlatformAction(
        db,
        operator,
        {
          action: `platform.tenant_${status}`,
          resourceType: 'tenant',
          resourceId: tenantId,
          tenantId,
          changes: { status: { from: tenant.status, to: status } },
          metadata: { reason: reason?.trim(), sessionsRevoked: Number(revoked[0]!.count) },
        },
        meta,
      );

      return rows[0]!;
    }

    await recordPlatformAction(
      db,
      operator,
      {
        action: 'platform.tenant_restored',
        resourceType: 'tenant',
        resourceId: tenantId,
        tenantId,
        changes: { status: { from: tenant.status, to: status } },
        metadata: { reason: reason?.trim() },
      },
      meta,
    );

    return rows[0]!;
  });
}

export async function setTenantTier(
  tenantId: string,
  tier: 'trial' | 'standard' | 'enterprise',
  reason: string | undefined,
  operator: PlatformPrincipal,
  meta: RequestMeta,
): Promise<Record<string, unknown>> {
  return withoutTenantIsolation('platform console: changing a hospital’s plan', async (db) => {
    const { rows: existing } = await db.query<{ subscription_tier: string }>(
      'SELECT subscription_tier FROM tenants WHERE id = $1 FOR UPDATE',
      [tenantId],
    );

    const current = existing[0];
    if (!current) throw new AppError(404, 'NOT_FOUND', 'That hospital could not be found.');

    const { rows } = await db.query(
      `UPDATE tenants SET subscription_tier = $2 WHERE id = $1
       RETURNING id, slug, display_name, status, subscription_tier`,
      [tenantId, tier],
    );

    await recordPlatformAction(
      db,
      operator,
      {
        action: 'platform.tenant_tier_changed',
        resourceType: 'tenant',
        resourceId: tenantId,
        tenantId,
        changes: { subscription_tier: { from: current.subscription_tier, to: tier } },
        metadata: { reason: reason?.trim() },
      },
      meta,
    );

    return rows[0]!;
  });
}
