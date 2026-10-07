/**
 * The vendor console: authentication, and the audit discipline everything
 * else in this module is held to.
 *
 * The console is the one place in this system that crosses tenant
 * boundaries, so two rules apply to every function below.
 *
 *   1. EVERY ACTION IS AUDITED, into the same hash-chained `audit_events`
 *      table the clinical path writes to, carrying the id of the operator who
 *      took it. A hospital reading its own audit trail therefore sees what
 *      the vendor did to its account — which is the property a customer
 *      actually wants, and the one a private vendor-only log quietly removes.
 *
 *   2. THE AUDIT ROW IS WRITTEN IN THE SAME TRANSACTION AS THE WORK. An
 *      action that rolls back must not leave a log entry claiming it
 *      happened, and one that commits must not be missing one.
 */
import type { Queryable } from '../../db/pool.js';
import { withoutTenantIsolation } from '../../db/pool.js';
import { AppError, ForbiddenError, UnauthenticatedError } from '../../utils/errors.js';
import { hashPassword, verifyPassword, assertPasswordPolicy } from '../../security/password.js';
import { randomToken, sha256 } from '../../security/crypto.js';
import {
  hashPlatformRefreshToken,
  issuePlatformRefreshToken,
  signPlatformToken,
} from '../../security/platform-tokens.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { PlatformPrincipal } from '../../middleware/authenticate-platform.js';

/* ---------------------------------------------------------------------------
 * Audit
 * ------------------------------------------------------------------------- */

export interface PlatformAuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  /** The hospital this touched, when it touched one. */
  tenantId?: string | null;
  outcome?: 'success' | 'denied' | 'error';
  changes?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
  requestId?: string | null;
}

/**
 * Write a platform action to the shared trail.
 *
 * `actor_user_id` stays NULL because an operator is not a row in `users` —
 * that column's foreign key would refuse them, which is the schema correctly
 * refusing to pretend the vendor is a member of the hospital.
 * `platform_actor_id` carries the real link and is covered by the chain
 * digest, and `actor_label` keeps the row readable if the operator account is
 * ever deleted.
 */
export async function recordPlatformAction(
  db: Queryable,
  operator: Pick<PlatformPrincipal, 'operatorId' | 'email'>,
  entry: PlatformAuditEntry,
  meta: RequestMeta = { ipAddress: null, userAgent: null },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (
       tenant_id, actor_user_id, actor_role, actor_label, platform_actor_id,
       action, outcome, resource_type, resource_id,
       request_id, ip_address, user_agent, changes, metadata
     ) VALUES ($1, NULL, 'platform_admin', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      entry.tenantId ?? null,
      operator.email,
      operator.operatorId,
      entry.action,
      entry.outcome ?? 'success',
      entry.resourceType,
      entry.resourceId ?? null,
      meta.requestId ?? null,
      meta.ipAddress,
      meta.userAgent,
      entry.changes ? JSON.stringify(entry.changes) : null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}

/* ---------------------------------------------------------------------------
 * Authentication
 * ------------------------------------------------------------------------- */

export interface PlatformSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  operator: {
    id: string;
    email: string;
    fullName: string;
    isOwner: boolean;
  };
}

/** One message for every failure mode, so the endpoint cannot enumerate accounts. */
const GENERIC_FAILURE = 'Those credentials are not correct.';

const ACCESS_TTL_SECONDS = 10 * 60;

async function startSession(
  db: Queryable,
  operator: { id: string; email: string; full_name: string; is_owner: boolean },
  meta: RequestMeta,
  familyId?: string,
): Promise<PlatformSession> {
  const refresh = issuePlatformRefreshToken();

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO platform_sessions (platform_user_id, refresh_token_hash, family_id,
                                    ip_address, user_agent, expires_at)
     VALUES ($1, $2, COALESCE($3::uuid, gen_random_uuid()), $4, $5, $6)
     RETURNING id`,
    [operator.id, refresh.hash, familyId ?? null, meta.ipAddress, meta.userAgent, refresh.expiresAt],
  );

  const sessionId = rows[0]!.id;

  return {
    accessToken: signPlatformToken({
      sub: operator.id,
      sid: sessionId,
      email: operator.email,
      isOwner: operator.is_owner,
    }),
    refreshToken: refresh.token,
    expiresIn: ACCESS_TTL_SECONDS,
    operator: {
      id: operator.id,
      email: operator.email,
      fullName: operator.full_name,
      isOwner: operator.is_owner,
    },
  };
}

export async function login(
  email: string,
  password: string,
  meta: RequestMeta,
): Promise<PlatformSession> {
  return withoutTenantIsolation('platform console: operator sign-in', async (db) => {
    const { rows } = await db.query<{
      id: string;
      email: string;
      full_name: string;
      is_owner: boolean;
      status: string;
      password_hash: string | null;
      failed_login_count: number;
      locked_until: Date | null;
    }>(
      `SELECT id, email, full_name, is_owner, status, password_hash,
              failed_login_count, locked_until
         FROM platform_users WHERE email = $1`,
      [email],
    );

    const operator = rows[0];

    // Verify against a dummy hash when the account is unknown, so a missing
    // address and a wrong password take the same time to refuse.
    if (!operator) {
      await verifyPassword(null, password);
      throw new UnauthenticatedError(GENERIC_FAILURE);
    }

    if (operator.locked_until && operator.locked_until > new Date()) {
      throw new AppError(
        423,
        'FORBIDDEN',
        'This account is temporarily locked after repeated failed sign-ins.',
      );
    }

    const ok = await verifyPassword(operator.password_hash, password);

    if (!ok) {
      const attempts = operator.failed_login_count + 1;
      const lock = attempts >= env.MAX_FAILED_LOGINS;

      await db.query(
        `UPDATE platform_users
            SET failed_login_count = $2,
                locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
          WHERE id = $1`,
        [operator.id, lock ? 0 : attempts, lock, env.ACCOUNT_LOCK_MINUTES],
      );

      logger.warn({ operatorId: operator.id, attempts, lock }, 'failed console sign-in');
      throw new UnauthenticatedError(GENERIC_FAILURE);
    }

    // An invited operator has no password set, so `verifyPassword` already
    // refused above; this catches suspension.
    if (operator.status !== 'active') {
      throw new ForbiddenError('This operator account is not active.');
    }

    await db.query(
      `UPDATE platform_users SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
        WHERE id = $1`,
      [operator.id],
    );

    const session = await startSession(db, operator, meta);

    await recordPlatformAction(
      db,
      { operatorId: operator.id, email: operator.email },
      { action: 'platform.login', resourceType: 'platform_user', resourceId: operator.id },
      meta,
    );

    return session;
  });
}

export async function refresh(token: string, meta: RequestMeta): Promise<PlatformSession> {
  const tokenHash = hashPlatformRefreshToken(token);

  return withoutTenantIsolation('platform console: rotating a session token', async (db) => {
    const { rows } = await db.query<{
      id: string;
      platform_user_id: string;
      family_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      email: string;
      full_name: string;
      is_owner: boolean;
      status: string;
    }>(
      `SELECT s.id, s.platform_user_id, s.family_id, s.expires_at, s.revoked_at,
              u.email, u.full_name, u.is_owner, u.status
         FROM platform_sessions s
         JOIN platform_users u ON u.id = s.platform_user_id
        WHERE s.refresh_token_hash = $1`,
      [tokenHash],
    );

    const session = rows[0];
    if (!session) throw new UnauthenticatedError('Please sign in to the console again.');

    // A token presented after it was rotated was copied. Burn the lineage
    // rather than the single token, which is the standard response: the
    // thief and the owner both get signed out, and the owner finds out.
    if (session.revoked_at) {
      await db.query(
        `UPDATE platform_sessions
            SET revoked_at = now(), revoked_reason = 'refresh_token_reuse'
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [session.family_id],
      );

      logger.error(
        { operatorId: session.platform_user_id, sessionId: session.id },
        'console refresh token reuse detected; revoked the session family',
      );

      throw new UnauthenticatedError(
        'Your console session was ended for security reasons. Please sign in again.',
      );
    }

    if (session.expires_at <= new Date()) {
      throw new UnauthenticatedError('Your console session has expired. Please sign in again.');
    }

    if (session.status !== 'active') {
      throw new ForbiddenError('This operator account is not active.');
    }

    await db.query(
      `UPDATE platform_sessions SET revoked_at = now(), revoked_reason = 'rotated' WHERE id = $1`,
      [session.id],
    );

    return startSession(
      db,
      {
        id: session.platform_user_id,
        email: session.email,
        full_name: session.full_name,
        is_owner: session.is_owner,
      },
      meta,
      session.family_id,
    );
  });
}

export async function logout(operator: PlatformPrincipal, meta: RequestMeta): Promise<void> {
  await withoutTenantIsolation('platform console: operator sign-out', async (db) => {
    await db.query(
      `UPDATE platform_sessions SET revoked_at = now(), revoked_reason = 'logout'
        WHERE id = $1 AND revoked_at IS NULL`,
      [operator.sessionId],
    );

    await recordPlatformAction(
      db,
      operator,
      { action: 'platform.logout', resourceType: 'platform_user', resourceId: operator.operatorId },
      meta,
    );
  });
}

/**
 * Set the password on an invited operator account.
 *
 * The invite token is the only credential accepted here, and it is consumed.
 * Nobody — including the owner who sent the invitation — ever knows this
 * password, which is what keeps a console action attributable to a person.
 */
export async function acceptInvite(
  token: string,
  password: string,
  meta: RequestMeta,
): Promise<PlatformSession> {
  const tokenHash = sha256(token);

  return withoutTenantIsolation('platform console: accepting an operator invitation', async (db) => {
    const { rows } = await db.query<{
      id: string;
      email: string;
      full_name: string;
      is_owner: boolean;
      invite_expires_at: Date | null;
    }>(
      `SELECT id, email, full_name, is_owner, invite_expires_at
         FROM platform_users
        WHERE invite_token_hash = $1 AND status = 'invited'`,
      [tokenHash],
    );

    const operator = rows[0];
    if (!operator || !operator.invite_expires_at || operator.invite_expires_at <= new Date()) {
      throw new UnauthenticatedError('That invitation is not valid or has expired.');
    }

    assertPasswordPolicy(password, { email: operator.email, fullName: operator.full_name });

    await db.query(
      `UPDATE platform_users
          SET password_hash = $2, status = 'active',
              invite_token_hash = NULL, invite_expires_at = NULL
        WHERE id = $1`,
      [operator.id, await hashPassword(password)],
    );

    const session = await startSession(
      db,
      { id: operator.id, email: operator.email, full_name: operator.full_name, is_owner: operator.is_owner },
      meta,
    );

    await recordPlatformAction(
      db,
      { operatorId: operator.id, email: operator.email },
      { action: 'platform.invite_accepted', resourceType: 'platform_user', resourceId: operator.id },
      meta,
    );

    return session;
  });
}

/* ---------------------------------------------------------------------------
 * Operators
 * ------------------------------------------------------------------------- */

export async function listOperators(): Promise<Record<string, unknown>[]> {
  return withoutTenantIsolation('platform console: listing operators', async (db) => {
    const { rows } = await db.query(
      `SELECT id, email, full_name, status, is_owner, last_login_at, created_at,
              (invite_expires_at IS NOT NULL AND invite_expires_at > now()) AS invite_pending
         FROM platform_users
        ORDER BY is_owner DESC, full_name`,
    );
    return rows;
  });
}

export async function inviteOperator(
  input: { email: string; fullName: string; isOwner: boolean },
  operator: PlatformPrincipal,
  meta: RequestMeta,
): Promise<{ id: string; inviteUrl: string }> {
  return withoutTenantIsolation('platform console: inviting an operator', async (db) => {
    const { rows: clash } = await db.query<{ id: string }>(
      'SELECT id FROM platform_users WHERE email = $1',
      [input.email],
    );

    if (clash.length > 0) {
      throw new AppError(409, 'CONFLICT', 'An operator with that email already exists.', {
        issues: [{ field: 'email', message: 'This address already has a console account.' }],
      });
    }

    const token = randomToken(32);

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO platform_users (email, full_name, is_owner, status,
                                   invite_token_hash, invite_expires_at)
       VALUES ($1, $2, $3, 'invited', $4, now() + interval '3 days')
       RETURNING id`,
      [input.email, input.fullName, input.isOwner, sha256(token)],
    );

    const id = rows[0]!.id;

    await recordPlatformAction(
      db,
      operator,
      {
        action: 'platform.operator_invited',
        resourceType: 'platform_user',
        resourceId: id,
        metadata: { email: input.email, isOwner: input.isOwner },
      },
      meta,
    );

    // Returned rather than emailed: there is no vendor-side mail template,
    // and inventing one that silently does nothing would be worse than
    // handing the link to the operator who created the invitation.
    return { id, inviteUrl: `${env.WEB_BASE_URL}/platform/accept-invite?token=${token}` };
  });
}

export async function setOperatorStatus(
  operatorId: string,
  status: 'active' | 'suspended',
  actor: PlatformPrincipal,
  meta: RequestMeta,
): Promise<Record<string, unknown>> {
  return withoutTenantIsolation('platform console: changing an operator account', async (db) => {
    const { rows } = await db.query<{ id: string; is_owner: boolean; status: string }>(
      'SELECT id, is_owner, status FROM platform_users WHERE id = $1 FOR UPDATE',
      [operatorId],
    );

    const target = rows[0];
    if (!target) throw new AppError(404, 'NOT_FOUND', 'That operator could not be found.');

    // Locking yourself out of the console is not a recoverable mistake: there
    // would be nobody left who could undo it.
    if (status === 'suspended' && target.is_owner) {
      const { rows: owners } = await db.query<{ remaining: string }>(
        `SELECT count(*) AS remaining FROM platform_users
          WHERE is_owner AND status = 'active' AND id <> $1`,
        [operatorId],
      );

      if (Number(owners[0]!.remaining) === 0) {
        throw new AppError(
          409,
          'PRECONDITION_FAILED',
          'This is the last active console owner. Promote another owner before suspending this one.',
        );
      }
    }

    const { rows: updated } = await db.query(
      `UPDATE platform_users SET status = $2 WHERE id = $1
       RETURNING id, email, full_name, status, is_owner, last_login_at, created_at`,
      [operatorId, status],
    );

    // A suspended operator's live sessions end now, not at token expiry.
    if (status === 'suspended') {
      await db.query(
        `UPDATE platform_sessions SET revoked_at = now(), revoked_reason = 'operator_suspended'
          WHERE platform_user_id = $1 AND revoked_at IS NULL`,
        [operatorId],
      );
    }

    await recordPlatformAction(
      db,
      actor,
      {
        action: `platform.operator_${status}`,
        resourceType: 'platform_user',
        resourceId: operatorId,
        changes: { status: { from: target.status, to: status } },
      },
      meta,
    );

    return updated[0]!;
  });
}
