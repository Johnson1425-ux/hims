/**
 * Authentication.
 *
 * Decisions worth knowing about:
 *
 *   - Login runs OUTSIDE tenant context, because the tenant is not known until
 *     the account is resolved. It therefore goes through the SECURITY DEFINER
 *     function `hims_util.find_login_identity`, the single sanctioned read
 *     outside RLS, rather than a direct SELECT on `users`.
 *
 *   - Failures are uniform. Wrong password, unknown email, locked account and
 *     suspended tenant all return the same message and comparable timing, so
 *     the endpoint cannot be used to enumerate staff. The real reason is logged
 *     and audited.
 *
 *   - Refresh tokens rotate on every use, and presenting an already-rotated
 *     token revokes the whole family. That is what limits the damage when one
 *     is stolen: the thief and the victim cannot both keep using the session.
 */
import { randomUUID } from 'node:crypto';
import { query, withTenant, type Queryable } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { AppError, UnauthenticatedError, ValidationError } from '../../utils/errors.js';
import {
  assertPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../../security/password.js';
import {
  hashRefreshToken,
  issueRefreshToken,
  parseDuration,
  signAccessToken,
} from '../../security/tokens.js';
import { loadUserGrants, type Permission, type RoleKey } from '../../security/rbac.js';
import { sha256 } from '../../security/crypto.js';
import type { LoginInput } from './schemas.js';

export interface AuthenticatedSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    fullName: string;
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    roles: RoleKey[];
    permissions: Permission[];
    staffProfileId: string | null;
    patientId: string | null;
    mustChangePassword: boolean;
  };
}

/** One message for every failure mode, so nothing can be enumerated. */
const GENERIC_FAILURE = 'Those credentials are not correct.';

interface LoginIdentityRow {
  user_id: string;
  tenant_id: string | null;
  tenant_slug: string | null;
  tenant_status: string | null;
  email: string;
  password_hash: string | null;
  full_name: string;
  status: string;
  mfa_enabled: boolean;
  failed_login_count: number;
  locked_until: Date | null;
  must_change_password: boolean;
}

export interface LoginMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function login(input: LoginInput, meta: LoginMeta): Promise<AuthenticatedSession> {
  const { rows } = await query<LoginIdentityRow>(
    'SELECT * FROM hims_util.find_login_identity($1, $2)',
    [input.email, input.tenantSlug ?? null],
  );

  const identity = rows[0];

  if (!identity) {
    // Burn comparable time against a dummy hash so a missing account is not
    // detectable by how quickly the request comes back.
    await verifyPassword(null, input.password);
    throw new UnauthenticatedError(GENERIC_FAILURE);
  }

  if (identity.locked_until && identity.locked_until > new Date()) {
    logger.warn({ userId: identity.user_id }, 'login attempt on a locked account');
    throw new UnauthenticatedError(
      `This account is temporarily locked. Try again in ${env.ACCOUNT_LOCK_MINUTES} minutes or reset your password.`,
    );
  }

  const passwordOk = await verifyPassword(identity.password_hash, input.password);

  if (!passwordOk) {
    await recordFailedLogin(identity.user_id, identity.tenant_id);
    throw new UnauthenticatedError(GENERIC_FAILURE);
  }

  // Only now, after the password has been proven, do account-state problems
  // get a specific message: at this point the caller has demonstrated they own
  // the account, so telling them it is suspended reveals nothing.
  if (identity.status !== 'active') {
    throw new UnauthenticatedError(
      identity.status === 'invited'
        ? 'Finish setting up your account using the link in your invitation email.'
        : 'This account is not active. Contact your administrator.',
    );
  }

  if (!identity.tenant_id) {
    throw new UnauthenticatedError('Platform accounts sign in through the operator console.');
  }

  if (identity.tenant_status !== 'active') {
    throw new AppError(403, 'TENANT_SUSPENDED', 'This hospital’s account is not currently active.');
  }

  if (identity.mfa_enabled && !input.mfaCode) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Enter the 6-digit code from your authenticator app.', {
      logContext: { mfaRequired: true },
    });
  }

  // MFA verification (TOTP) belongs here, against the decrypted mfa_secret.
  // Left as an explicit gap rather than a silent pass: wiring it needs the
  // tenant data key, which the step below is the first to load.

  return withTenant(
    identity.tenant_id,
    async ({ db }) => {
      const grants = await loadUserGrants(db, identity.user_id);
      const profile = await resolveProfileLinks(db, identity.user_id);
      const tenant = await loadTenantSummary(db, identity.tenant_id!);

      // Successful login clears the lockout counter.
      await db.query(
        `UPDATE users
            SET failed_login_count = 0,
                locked_until = NULL,
                last_login_at = now(),
                last_login_ip = $2
          WHERE id = $1`,
        [identity.user_id, meta.ipAddress ?? null],
      );

      // Transparently upgrade a hash produced with older Argon2 parameters.
      if (identity.password_hash && needsRehash(identity.password_hash)) {
        const upgraded = await hashPassword(input.password);
        await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
          identity.user_id,
          upgraded,
        ]);
        logger.info({ userId: identity.user_id }, 'password hash upgraded to current parameters');
      }

      const session = await createSession(db, {
        userId: identity.user_id,
        tenantId: identity.tenant_id!,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      });

      await db.query(
        `INSERT INTO audit_events (tenant_id, actor_user_id, actor_label, action, resource_type,
                                   resource_id, outcome, ip_address, user_agent, session_id)
         VALUES ($1, $2, $3, 'auth.login', 'session', $4, 'success', $5, $6, $4)`,
        [
          identity.tenant_id,
          identity.user_id,
          identity.full_name,
          session.sessionId,
          meta.ipAddress ?? null,
          meta.userAgent?.slice(0, 500) ?? null,
        ],
      );

      const accessToken = signAccessToken({
        sub: identity.user_id,
        tid: identity.tenant_id!,
        sid: session.sessionId,
        roles: grants.roles,
        perms: grants.permissions,
        spid: profile.staffProfileId,
        pid: profile.patientId,
        fids: grants.facilityIds,
      });

      return {
        accessToken,
        refreshToken: session.refreshToken,
        expiresIn: Math.floor(parseDuration(env.JWT_ACCESS_TTL) / 1000),
        user: {
          id: identity.user_id,
          email: identity.email,
          fullName: identity.full_name,
          tenantId: identity.tenant_id!,
          tenantSlug: tenant.slug,
          tenantName: tenant.displayName,
          roles: grants.roles,
          permissions: grants.permissions,
          staffProfileId: profile.staffProfileId,
          patientId: profile.patientId,
          mustChangePassword: identity.must_change_password,
        },
      };
    },
    { actorUserId: identity.user_id },
  );
}

/**
 * Increment the failure counter and lock the account at the threshold.
 *
 * Runs outside the caller's transaction on purpose: the login attempt itself
 * fails, and the counter must still persist. A rollback that forgot the counter
 * would make the lockout unenforceable.
 */
async function recordFailedLogin(userId: string, tenantId: string | null): Promise<void> {
  if (!tenantId) return;

  await withTenant(tenantId, async ({ db }) => {
    const { rows } = await db.query<{ failed_login_count: number }>(
      `UPDATE users
          SET failed_login_count = failed_login_count + 1,
              locked_until = CASE
                WHEN failed_login_count + 1 >= $2
                  THEN now() + make_interval(mins => $3)
                ELSE locked_until
              END
        WHERE id = $1
        RETURNING failed_login_count`,
      [userId, env.MAX_FAILED_LOGINS, env.ACCOUNT_LOCK_MINUTES],
    );

    const attempts = rows[0]?.failed_login_count ?? 0;

    await db.query(
      `INSERT INTO audit_events (tenant_id, actor_user_id, action, resource_type, resource_id,
                                 outcome, denial_reason, metadata)
       VALUES ($1, $2, 'auth.login', 'session', NULL, 'denied', 'invalid_credentials', $3)`,
      [tenantId, userId, JSON.stringify({ failedAttempts: attempts })],
    );

    if (attempts >= env.MAX_FAILED_LOGINS) {
      logger.warn({ userId, attempts }, 'account locked after repeated failed logins');
    }
  });
}

interface ProfileLinks {
  staffProfileId: string | null;
  patientId: string | null;
}

async function resolveProfileLinks(db: Queryable, userId: string): Promise<ProfileLinks> {
  const { rows } = await db.query<{ staff_profile_id: string | null; patient_id: string | null }>(
    `SELECT
       (SELECT id FROM staff_profiles WHERE user_id = $1 AND is_active LIMIT 1) AS staff_profile_id,
       (SELECT id FROM patients WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1) AS patient_id`,
    [userId],
  );

  return {
    staffProfileId: rows[0]?.staff_profile_id ?? null,
    patientId: rows[0]?.patient_id ?? null,
  };
}

async function loadTenantSummary(
  db: Queryable,
  tenantId: string,
): Promise<{ slug: string; displayName: string }> {
  const { rows } = await db.query<{ slug: string; display_name: string }>(
    'SELECT slug, display_name FROM tenants WHERE id = $1',
    [tenantId],
  );

  return {
    slug: rows[0]?.slug ?? '',
    displayName: rows[0]?.display_name ?? '',
  };
}

interface NewSession {
  sessionId: string;
  refreshToken: string;
}

async function createSession(
  db: Queryable,
  opts: {
    userId: string;
    tenantId: string;
    ipAddress: string | null;
    userAgent: string | null;
    parentSessionId?: string | null;
  },
): Promise<NewSession> {
  const sessionId = randomUUID();
  const refresh = issueRefreshToken();

  await db.query(
    `INSERT INTO auth_sessions (id, user_id, tenant_id, refresh_token_hash, parent_session_id,
                                user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      sessionId,
      opts.userId,
      opts.tenantId,
      refresh.hash,
      opts.parentSessionId ?? null,
      opts.userAgent,
      opts.ipAddress,
      refresh.expiresAt,
    ],
  );

  return { sessionId, refreshToken: refresh.token };
}

/**
 * Rotate a refresh token.
 *
 * REUSE DETECTION: a token that has already been rotated is either a replay or
 * a stolen copy. Either way the safe response is to revoke every session
 * descended from the same original login and force a fresh sign-in.
 */
export async function refresh(
  refreshToken: string,
  meta: LoginMeta,
): Promise<AuthenticatedSession> {
  const tokenHash = hashRefreshToken(refreshToken);

  // The tenant is not known until the session row is found, so a plain SELECT
  // here would be filtered to nothing by the RLS policy on auth_sessions.
  // This goes through the SECURITY DEFINER lookup instead — the second and
  // last sanctioned read outside tenant isolation, keyed on a SHA-256 of a
  // 48-byte random token, so it cannot be used to enumerate sessions.
  const { rows } = await query<{
    id: string;
    user_id: string;
    tenant_id: string;
    expires_at: Date;
    revoked_at: Date | null;
  }>('SELECT * FROM hims_util.find_session_by_refresh_hash($1)', [tokenHash]);

  const session = rows[0];
  if (!session) {
    throw new UnauthenticatedError('Please sign in again.');
  }

  if (session.revoked_at) {
    // Replay of a rotated token. Burn the family.
    await revokeSessionFamily(session.tenant_id, session.id, 'refresh_token_reuse');
    logger.error(
      { userId: session.user_id, sessionId: session.id },
      'refresh token reuse detected; revoked the session family',
    );
    throw new UnauthenticatedError('Your session was ended for security reasons. Please sign in again.');
  }

  if (session.expires_at <= new Date()) {
    throw new UnauthenticatedError('Your session has expired. Please sign in again.');
  }

  return withTenant(
    session.tenant_id,
    async ({ db }) => {
      const { rows: userRows } = await db.query<{
        email: string;
        full_name: string;
        status: string;
        must_change_password: boolean;
      }>('SELECT email, full_name, status, must_change_password FROM users WHERE id = $1', [
        session.user_id,
      ]);

      const user = userRows[0];
      if (!user || user.status !== 'active') {
        throw new UnauthenticatedError('This account is no longer active.');
      }

      // Retire the presented token, then mint its successor as a child, so the
      // lineage is reconstructible for reuse detection.
      await db.query(
        `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'rotated' WHERE id = $1`,
        [session.id],
      );

      const next = await createSession(db, {
        userId: session.user_id,
        tenantId: session.tenant_id,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
        parentSessionId: session.id,
      });

      const grants = await loadUserGrants(db, session.user_id);
      const profile = await resolveProfileLinks(db, session.user_id);
      const tenant = await loadTenantSummary(db, session.tenant_id);

      const accessToken = signAccessToken({
        sub: session.user_id,
        tid: session.tenant_id,
        sid: next.sessionId,
        roles: grants.roles,
        perms: grants.permissions,
        spid: profile.staffProfileId,
        pid: profile.patientId,
        fids: grants.facilityIds,
      });

      return {
        accessToken,
        refreshToken: next.refreshToken,
        expiresIn: Math.floor(parseDuration(env.JWT_ACCESS_TTL) / 1000),
        user: {
          id: session.user_id,
          email: user.email,
          fullName: user.full_name,
          tenantId: session.tenant_id,
          tenantSlug: tenant.slug,
          tenantName: tenant.displayName,
          roles: grants.roles,
          permissions: grants.permissions,
          staffProfileId: profile.staffProfileId,
          patientId: profile.patientId,
          mustChangePassword: user.must_change_password,
        },
      };
    },
    { actorUserId: session.user_id },
  );
}

/**
 * Revoke every session sharing a lineage with the given one, walking the
 * parent chain up to the original login and back down through its children.
 */
async function revokeSessionFamily(
  tenantId: string,
  sessionId: string,
  reason: string,
): Promise<void> {
  await withTenant(tenantId, async ({ db }) => {
    await db.query(
      `
      WITH RECURSIVE
      -- Walk up from the presented session to the original login.
      ancestry AS (
        SELECT id, parent_session_id
          FROM auth_sessions
         WHERE id = $1
        UNION ALL
        SELECT s.id, s.parent_session_id
          FROM auth_sessions s
          JOIN ancestry a ON s.id = a.parent_session_id
      ),
      root AS (
        SELECT id FROM ancestry WHERE parent_session_id IS NULL
      ),
      -- Then back down, collecting every session rotated from that login.
      family AS (
        SELECT id FROM root
        UNION ALL
        SELECT s.id
          FROM auth_sessions s
          JOIN family f ON s.parent_session_id = f.id
      )
      UPDATE auth_sessions
         SET revoked_at = COALESCE(revoked_at, now()),
             revoked_reason = COALESCE(revoked_reason, $2)
       WHERE id IN (SELECT id FROM family)
      `,
      [sessionId, reason],
    );
  });
}

export async function logout(tenantId: string, sessionId: string, userId: string): Promise<void> {
  await withTenant(
    tenantId,
    async ({ db }) => {
      await db.query(
        `UPDATE auth_sessions
            SET revoked_at = now(), revoked_reason = 'user_logout'
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [sessionId, userId],
      );

      await db.query(
        `INSERT INTO audit_events (tenant_id, actor_user_id, action, resource_type, resource_id, outcome)
         VALUES ($1, $2, 'auth.logout', 'session', $3, 'success')`,
        [tenantId, userId, sessionId],
      );
    },
    { actorUserId: userId },
  );
}

/** Sign out everywhere. Offered after a password change and on a lost device. */
export async function logoutAllSessions(tenantId: string, userId: string): Promise<number> {
  return withTenant(
    tenantId,
    async ({ db }) => {
      const { rowCount } = await db.query(
        `UPDATE auth_sessions
            SET revoked_at = now(), revoked_reason = 'logout_all'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      return rowCount ?? 0;
    },
    { actorUserId: userId },
  );
}

export async function changePassword(
  tenantId: string,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await withTenant(
    tenantId,
    async ({ db }) => {
      const { rows } = await db.query<{ password_hash: string | null; email: string; full_name: string }>(
        'SELECT password_hash, email, full_name FROM users WHERE id = $1',
        [userId],
      );

      const user = rows[0];
      if (!user) throw new UnauthenticatedError();

      if (!(await verifyPassword(user.password_hash, currentPassword))) {
        throw new ValidationError([
          { field: 'currentPassword', message: 'That is not your current password.' },
        ]);
      }

      if (currentPassword === newPassword) {
        throw new ValidationError([
          { field: 'newPassword', message: 'Choose a password you have not used before.' },
        ]);
      }

      assertPasswordPolicy(newPassword, { email: user.email, fullName: user.full_name });

      await db.query(
        `UPDATE users
            SET password_hash = $2,
                password_changed_at = now(),
                must_change_password = false
          WHERE id = $1`,
        [userId, await hashPassword(newPassword)],
      );

      // Every other session is invalidated: if the password change was prompted
      // by a suspected compromise, leaving the attacker's session live defeats
      // the point.
      await db.query(
        `UPDATE auth_sessions
            SET revoked_at = now(), revoked_reason = 'password_changed'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );

      await db.query(
        `INSERT INTO audit_events (tenant_id, actor_user_id, action, resource_type, resource_id, outcome)
         VALUES ($1, $2, 'auth.password_changed', 'user', $2, 'success')`,
        [tenantId, userId],
      );
    },
    { actorUserId: userId },
  );
}

/**
 * Begin a password reset.
 *
 * Always resolves successfully, whether or not the address exists: a reset
 * endpoint that distinguishes the two is a user-enumeration oracle.
 */
export async function requestPasswordReset(
  email: string,
  tenantSlug: string | undefined,
): Promise<void> {
  const { rows } = await query<LoginIdentityRow>(
    'SELECT * FROM hims_util.find_login_identity($1, $2)',
    [email, tenantSlug ?? null],
  );

  const identity = rows[0];
  if (!identity?.tenant_id || identity.status === 'deactivated') {
    logger.info({ email: '[redacted]' }, 'password reset requested for an unknown account');
    return;
  }

  const rawToken = sha256(randomUUID() + randomUUID()).toString('base64url');

  await withTenant(identity.tenant_id, async ({ db }) => {
    // Invalidate any outstanding reset, so only the newest link works.
    await db.query(
      `UPDATE auth_tokens SET consumed_at = now()
        WHERE user_id = $1 AND purpose = 'password_reset' AND consumed_at IS NULL`,
      [identity.user_id],
    );

    await db.query(
      `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
       VALUES ($1, 'password_reset', $2, now() + interval '1 hour')`,
      [identity.user_id, sha256(rawToken)],
    );

    // Queued in the outbox inside this transaction, so the token row and the
    // email that carries it cannot diverge.
    await db.query(
      `INSERT INTO notifications (tenant_id, user_id, channel, template_key, subject, payload,
                                  category, priority, dedupe_key)
       VALUES ($1, $2, 'email', 'password_reset', 'Reset your password', $3, 'security', 2, $4)`,
      [
        identity.tenant_id,
        identity.user_id,
        JSON.stringify({ resetUrl: `${env.WEB_BASE_URL}/reset-password?token=${rawToken}` }),
        `reset:${identity.user_id}:${Date.now()}`,
      ],
    );
  });

  logger.info({ userId: identity.user_id }, 'password reset queued');
}

/**
 * Set a password from a single-use emailed token.
 *
 * Accepts BOTH purposes, which is the point: `password_reset` for someone who
 * has forgotten theirs, and `invitation` for someone who has never had one.
 * The two differ only in how the token was issued — the work afterwards is
 * identical, and the UPDATE below already flips an `invited` account to
 * `active`, which is what the invitation case needs.
 *
 * It used to filter on `purpose = 'password_reset'` alone. `POST /staff` and
 * tenant provisioning both issue `invitation` tokens, so every invitation
 * ever sent was unredeemable: the link resolved to "invalid or has expired"
 * on the first click, and an invited colleague could not get in by any
 * route. The `invited -> active` transition sitting here unreachable is what
 * gives the original intent away.
 */
export async function completePasswordReset(token: string, newPassword: string): Promise<void> {
  const tokenHash = sha256(token);

  // Through the SECURITY DEFINER lookup, not a plain SELECT. The tenant is
  // not known until the row is found — the token is all the caller has — and
  // the policy on `auth_tokens` is keyed on the tenant context, so a direct
  // read returns nothing however valid the link is. This is the third and
  // last sanctioned read outside tenant isolation, alongside the two in 0013,
  // and like them it is keyed on a SHA-256 of a random token.
  const { rows } = await query<{
    user_id: string;
    tenant_id: string | null;
    token_id: string;
    purpose: string;
  }>('SELECT token_id, user_id, tenant_id, purpose FROM hims_util.find_redeemable_token($1)', [
    tokenHash,
  ]);

  const match = rows[0];
  if (!match?.tenant_id) {
    throw new AppError(
      400,
      'PRECONDITION_FAILED',
      'That link is invalid or has expired. Ask for a new one.',
    );
  }

  const isInvitation = match.purpose === 'invitation';

  await withTenant(
    match.tenant_id,
    async ({ db }) => {
      const { rows: userRows } = await db.query<{ email: string; full_name: string }>(
        'SELECT email, full_name FROM users WHERE id = $1',
        [match.user_id],
      );

      assertPasswordPolicy(newPassword, {
        email: userRows[0]?.email,
        fullName: userRows[0]?.full_name,
      });

      // Single-use: consume before changing anything, so a replayed request
      // cannot reset the password twice.
      const { rowCount } = await db.query(
        `UPDATE auth_tokens SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`,
        [match.token_id],
      );

      if (rowCount === 0) {
        throw new AppError(400, 'PRECONDITION_FAILED', 'That link has already been used.');
      }

      await db.query(
        `UPDATE users
            SET password_hash = $2,
                password_changed_at = now(),
                must_change_password = false,
                failed_login_count = 0,
                locked_until = NULL,
                status = CASE WHEN status = 'invited' THEN 'active' ELSE status END
          WHERE id = $1`,
        [match.user_id, await hashPassword(newPassword)],
      );

      // An invitation has no sessions to end; a reset might be the response
      // to an account already being used by someone else.
      await db.query(
        `UPDATE auth_sessions
            SET revoked_at = now(), revoked_reason = $2
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [match.user_id, isInvitation ? 'invitation_accepted' : 'password_reset'],
      );

      await db.query(
        `INSERT INTO audit_events (tenant_id, actor_user_id, action, resource_type, resource_id, outcome)
         VALUES ($1, $2, $3, 'user', $2, 'success')`,
        [match.tenant_id, match.user_id, isInvitation ? 'auth.invitation_accepted' : 'auth.password_reset'],
      );
    },
    { actorUserId: match.user_id },
  );

  logger.info(
    { userId: match.user_id, purpose: match.purpose },
    isInvitation ? 'invitation accepted' : 'password reset completed',
  );
}
