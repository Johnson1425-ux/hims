/**
 * Tenant-scoped execution for route handlers.
 *
 * An earlier version of this file held one transaction open for the whole
 * request and committed on the response's `finish` event. That is a trap: the
 * status line is already on the wire by then, so a failed COMMIT cannot be
 * reported to the caller — the client is told the appointment was booked while
 * the database rolled it back.
 *
 * So the unit of work is the HANDLER, not the request. A handler calls
 * `runInTenant`, which opens a transaction, applies RLS context, runs the work,
 * flushes the audit rows the work produced INSIDE the same transaction, and
 * commits before returning. The response is written afterwards, from a result
 * that is already durable.
 *
 * Keeping audit writes in that transaction is deliberate: an action that rolls
 * back must not leave a log entry claiming it happened, and an action that
 * commits must not be missing one.
 */
import type { Request } from 'express';
import { withTenant, type TenantContext, type WithTenantOptions } from '../db/pool.js';
import { UnauthenticatedError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { AuditEntry } from '../types/express.js';
import { insertAuditEntries } from './audit.js';

/**
 * Run `fn` in a transaction scoped to the caller's tenant.
 *
 * `collect` lets the handler queue audit entries that are written atomically
 * with the work. Entries pushed onto `req.auditEntries` instead are flushed
 * after the response by the audit middleware, which is the right place for
 * request-level events such as a permission denial.
 */
export async function runInTenant<T>(
  req: Request,
  fn: (ctx: TenantContext, collect: (entry: AuditEntry) => void) => Promise<T>,
  options: Omit<WithTenantOptions, 'actorUserId'> = {},
): Promise<T> {
  const principal = req.principal;
  if (!principal) throw new UnauthenticatedError();

  const readOnly = options.readOnly ?? false;
  const entries: AuditEntry[] = [];

  const result = await withTenant(
    principal.tenantId,
    async (ctx) => {
      const value = await fn(ctx, (entry) => entries.push(entry));

      // A READ ONLY transaction cannot INSERT, so a read-only scope's audit
      // rows are written just after it commits, below.
      if (!readOnly && entries.length > 0) {
        await insertAuditEntries(ctx.db, req, entries);
      }

      return value;
    },
    { ...options, actorUserId: principal.userId },
  );

  if (readOnly && entries.length > 0) {
    // Not atomic with the read, and it does not need to be: a read has nothing
    // to roll back, so the only exposure is a successful read whose audit write
    // fails. That is logged at error level and treated as a compliance
    // incident rather than silently swallowed.
    try {
      await withTenant(
        principal.tenantId,
        async (ctx) => insertAuditEntries(ctx.db, req, entries),
        { actorUserId: principal.userId },
      );
    } catch (error) {
      logger.error(
        { err: error, requestId: req.requestId, count: entries.length, userId: principal.userId },
        'AUDIT WRITE FAILED for a read-only scope - investigate',
      );
    }
  }

  return result;
}

/**
 * Read-only variant for searches, chart reads, reports and exports. The
 * transaction is marked READ ONLY, so a reporting query cannot mutate a chart
 * however it is written; `runInTenant` then writes any audit rows the handler
 * collected in a short follow-up transaction.
 */
export async function runInTenantReadOnly<T>(
  req: Request,
  fn: (ctx: TenantContext, collect: (entry: AuditEntry) => void) => Promise<T>,
): Promise<T> {
  return runInTenant(req, fn, { readOnly: true });
}

/**
 * Serializable variant for the two places where a lost update is a clinical or
 * financial error rather than an inconvenience: slot booking and dispensing.
 * `withTenant` already retries once on a serialization failure.
 */
export async function runInTenantSerializable<T>(
  req: Request,
  fn: (ctx: TenantContext, collect: (entry: AuditEntry) => void) => Promise<T>,
): Promise<T> {
  return runInTenant(req, fn, { isolation: 'serializable' });
}
