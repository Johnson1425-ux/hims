/**
 * What the console is allowed to SEE, as opposed to change.
 *
 * The restraint here is the design. A BYPASSRLS connection could read any
 * chart in any hospital, so the question for every query below is not "can
 * it" but "does a support operator need it". The answers:
 *
 *   - The vendor's own actions, across every tenant. Obviously yes: this is
 *     the record of what the console did.
 *   - The break-glass review queue, as COUNTS AND METADATA — who broke glass,
 *     when, whether a privacy officer has reviewed it. Not the chart, not the
 *     patient's name, not the justification's subject. A vendor operator
 *     needs to know a hospital has forty unreviewed emergency accesses; they
 *     do not need to know whose records those were.
 *   - Tenant activity as volume figures only.
 *
 * No endpoint in this module returns patient data, and none should be added
 * that does. If support genuinely needs to see a chart, that is a break-glass
 * grant inside the hospital's own system, taken by a named person and
 * reviewed by that hospital's privacy officer — not a vendor back door.
 */
import { withoutTenantIsolation } from '../../db/pool.js';

export interface AuditQuery {
  tenantId?: string;
  platformOnly: boolean;
  action?: string;
  page: number;
  pageSize: number;
}

export async function listAuditEvents(
  input: AuditQuery,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  return withoutTenantIsolation('platform console: reading the cross-tenant audit trail', async (db) => {
    const filters: string[] = [];
    const params: unknown[] = [];

    if (input.platformOnly) {
      filters.push('a.platform_actor_id IS NOT NULL');
    }
    if (input.tenantId) {
      params.push(input.tenantId);
      filters.push(`a.tenant_id = $${params.length}`);
    }
    if (input.action) {
      params.push(`${input.action}%`);
      filters.push(`a.action LIKE $${params.length}`);
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const { rows: counts } = await db.query<{ total: string }>(
      `SELECT count(*) AS total FROM audit_events a ${where}`,
      params,
    );

    params.push(input.pageSize, (input.page - 1) * input.pageSize);

    // `changes` and `metadata` are returned, `patient_id` is not. The first
    // two hold field names and vendor-side context; the third is the one
    // column on this table that identifies a person.
    const { rows } = await db.query(
      `SELECT a.id, a.occurred_at, a.action, a.outcome, a.resource_type, a.resource_id,
              a.actor_label, a.actor_role, a.ip_address, a.changes, a.metadata,
              a.platform_actor_id IS NOT NULL AS by_platform,
              a.touched_phi,
              t.slug AS tenant_slug, t.display_name AS tenant_name
         FROM audit_events a
         LEFT JOIN tenants t ON t.id = a.tenant_id
         ${where}
        ORDER BY a.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows, total: Number(counts[0]!.total) };
  });
}

export interface BreakGlassQuery {
  tenantId?: string;
  unreviewedOnly: boolean;
  page: number;
  pageSize: number;
}

/**
 * The emergency-access review queue, across hospitals.
 *
 * Deliberately WITHOUT the patient, and without the justification text. A
 * justification reads "chest pain, unresponsive, no notes available" — that
 * is clinical detail about an identifiable person, and the privacy officer
 * inside the hospital is who reads it. What a vendor operator gets is the
 * shape of the problem: which hospitals are accumulating unreviewed
 * emergency accesses, and how old the oldest one is. That is enough to raise
 * it with the customer, which is the only legitimate thing to do with it.
 */
export async function listBreakGlass(
  input: BreakGlassQuery,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  return withoutTenantIsolation('platform console: break-glass oversight across tenants', async (db) => {
    const filters: string[] = [];
    const params: unknown[] = [];

    if (input.unreviewedOnly) filters.push('b.reviewed_at IS NULL');
    if (input.tenantId) {
      params.push(input.tenantId);
      filters.push(`b.tenant_id = $${params.length}`);
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const { rows: counts } = await db.query<{ total: string }>(
      `SELECT count(*) AS total FROM break_glass_grants b ${where}`,
      params,
    );

    params.push(input.pageSize, (input.page - 1) * input.pageSize);

    const { rows } = await db.query(
      `SELECT b.id, b.created_at, b.expires_at, b.reviewed_at, b.review_outcome,
              length(b.justification) AS justification_length,
              u.full_name AS clinician_name,
              t.slug AS tenant_slug, t.display_name AS tenant_name,
              (b.expires_at > now()) AS still_active
         FROM break_glass_grants b
         JOIN tenants t ON t.id = b.tenant_id
         LEFT JOIN users u ON u.id = b.user_id
         ${where}
        ORDER BY b.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows, total: Number(counts[0]!.total) };
  });
}

/** The numbers on the console's front page. */
export async function platformSummary(): Promise<Record<string, unknown>> {
  return withoutTenantIsolation('platform console: fleet summary', async (db) => {
    const { rows } = await db.query(
      `SELECT
         (SELECT count(*) FROM tenants) AS tenant_count,
         (SELECT count(*) FROM tenants WHERE status = 'active') AS active_tenants,
         (SELECT count(*) FROM tenants WHERE status = 'suspended') AS suspended_tenants,
         (SELECT count(*) FROM tenants WHERE status = 'archived') AS archived_tenants,
         (SELECT count(*) FROM tenants WHERE subscription_tier = 'trial' AND status = 'active')
           AS trial_tenants,
         (SELECT count(*) FROM users WHERE status = 'active') AS active_users,
         (SELECT count(*) FROM break_glass_grants WHERE reviewed_at IS NULL)
           AS unreviewed_break_glass,
         (SELECT count(*) FROM platform_users WHERE status = 'active') AS active_operators,
         (SELECT count(*) FROM audit_events WHERE platform_actor_id IS NOT NULL
            AND occurred_at > now() - interval '7 days') AS platform_actions_7d`,
    );

    return rows[0]!;
  });
}

/**
 * Walk the hash chain and report the first row that does not reconcile.
 *
 * This is the one place in the product that can run the check meaningfully:
 * `verify_audit_chain` reads `audit_events` as the caller, and every other
 * connection in the system is filtered by row-level security to one tenant
 * or to nothing at all. Run as the migration role it used to see zero rows
 * and report success — which is why the function now refuses rather than
 * passing vacuously.
 */
export async function verifyAuditChain(): Promise<{
  intact: boolean;
  brokenAtId: string | null;
}> {
  return withoutTenantIsolation('platform console: verifying the audit hash chain', async (db) => {
    const { rows } = await db.query<{ broken_at_id: string }>(
      'SELECT broken_at_id FROM hims_util.verify_audit_chain()',
    );

    return { intact: rows.length === 0, brokenAtId: rows[0]?.broken_at_id ?? null };
  });
}
