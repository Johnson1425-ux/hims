/**
 * Audit trail writer.
 *
 * HIPAA §164.312(b) requires a record of activity in systems holding ePHI.
 * What makes this trail useful rather than merely present:
 *
 *   - READS are recorded, not just writes. "Who opened this chart" is the
 *     question an investigation asks.
 *   - DENIALS are recorded. A nurse repeatedly bouncing off a chart they have
 *     no relationship with is the signal worth reviewing.
 *   - `changes` holds FIELD NAMES, never values. The audit log must not become
 *     a second, unencrypted copy of the medical record.
 */
import type { Request, Response } from 'express';
import type { Queryable } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import type { AuditEntry } from '../types/express.js';
import { PHI_PERMISSIONS } from '../security/rbac.js';

/**
 * Field names whose values must never be serialised into `changes`, even when
 * a handler passes them in by mistake. Belt and braces over the redaction in
 * the logger: the audit table outlives the log retention window.
 */
const NEVER_RECORD_VALUES = new Set([
  'password', 'passwordHash', 'password_hash', 'mfaSecret', 'token', 'refreshToken',
  'nationalId', 'national_id', 'ssn', 'memberNumber', 'member_number',
  'phone', 'email', 'address', 'dateOfBirth', 'date_of_birth',
  'subjective', 'objective', 'assessment', 'plan', 'chiefComplaint', 'notes',
  'answers', 'interpretation', 'reason',
]);

/**
 * Reduce a change set to something safe to retain forever: which fields moved,
 * and for non-sensitive scalars, what they moved to.
 */
export function summariseChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Record<string, unknown> {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const summary: Record<string, unknown> = {};

  for (const key of keys) {
    const from = before?.[key];
    const to = after?.[key];
    if (from === to) continue;
    if (JSON.stringify(from) === JSON.stringify(to)) continue;

    if (NEVER_RECORD_VALUES.has(key)) {
      // Record that it changed, not what it changed to.
      summary[key] = { changed: true };
      continue;
    }

    const isScalar = (v: unknown) =>
      v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);

    summary[key] =
      isScalar(from) && isScalar(to)
        ? { from: from ?? null, to: to ?? null }
        : { changed: true };
  }

  return summary;
}

/** Insert audit rows on a given connection. The hash chain is built by a trigger. */
export async function insertAuditEntries(
  db: Queryable,
  req: Request,
  entries: AuditEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  const principal = req.principal;

  for (const entry of entries) {
    await db.query(
      `
      INSERT INTO audit_events (
        tenant_id, actor_user_id, actor_role, actor_label,
        action, outcome, denial_reason,
        resource_type, resource_id, patient_id, touched_phi,
        http_method, http_path, http_status,
        request_id, session_id, ip_address, user_agent,
        changes, metadata
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14,
        $15, $16, $17, $18,
        $19, $20
      )
      `,
      [
        principal?.tenantId ?? null,
        principal?.userId ?? null,
        principal?.roles?.[0] ?? null,
        principal?.fullName || principal?.email || null,
        entry.action,
        entry.outcome ?? 'success',
        entry.denialReason ?? null,
        entry.resourceType,
        entry.resourceId ?? null,
        entry.patientId ?? null,
        entry.touchedPhi ?? false,
        req.method,
        // The route pattern, not the populated path: a URL can embed an MRN.
        req.route?.path ? `${req.baseUrl}${req.route.path}` : req.baseUrl || req.path,
        null,
        req.requestId,
        principal?.sessionId ?? null,
        req.ip ?? null,
        req.header('user-agent')?.slice(0, 500) ?? null,
        entry.changes ? JSON.stringify(entry.changes) : null,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
  }
}

/**
 * Flush request-level audit entries after the response.
 *
 * Only entries still sitting on `req.auditEntries` reach here — chiefly
 * permission denials, which have no successful transaction to ride along with.
 * Written on a fresh connection in its own transaction, because the handler's
 * transaction has already been rolled back by the time a denial is known.
 */
export function auditFlush() {
  return (req: Request, res: Response, next: () => void): void => {
    res.on('finish', () => {
      const entries = req.auditEntries;
      if (!entries || entries.length === 0) return;

      void (async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // Tenant context is needed for the RLS insert policy on audit_events.
          await client.query('SELECT hims_util.set_request_context($1, $2, true)', [
            req.principal?.tenantId ?? null,
            req.principal?.userId ?? null,
          ]);

          const stamped = entries.map((e) => ({
            ...e,
            metadata: { ...e.metadata, httpStatus: res.statusCode },
          }));

          // pg's client.query is heavily overloaded; wrapping it behind the
          // narrow Queryable shape keeps the call site unambiguous.
          const queryable: Queryable = {
            query: (sql, params) => client.query(sql, params ? [...params] : undefined),
          };

          await insertAuditEntries(queryable, req, stamped);
          await client.query('COMMIT');
        } catch (error) {
          // An audit write must never break the response, but a silent failure
          // here is itself a compliance incident, so log it loudly.
          await client.query('ROLLBACK').catch(() => undefined);
          logger.error(
            { err: error, requestId: req.requestId, count: entries.length },
            'AUDIT WRITE FAILED - investigate',
          );
        } finally {
          client.release();
        }
      })();
    });

    next();
  };
}

/** Convenience for handlers: record a PHI read with the basis for access. */
export function auditPhiRead(
  collect: (entry: AuditEntry) => void,
  opts: { action: string; resourceType: string; resourceId?: string; patientId: string; basis: string },
): void {
  collect({
    action: opts.action,
    resourceType: opts.resourceType,
    resourceId: opts.resourceId ?? opts.patientId,
    patientId: opts.patientId,
    touchedPhi: true,
    outcome: 'success',
    metadata: { accessBasis: opts.basis },
  });
}

export { PHI_PERMISSIONS };
