/**
 * Bearer-token authentication.
 *
 * Builds the `Principal` every authorisation decision reads from. Two checks
 * here are easy to leave out and expensive to omit:
 *
 *   - The session row is re-read, so signing out on a lost phone immediately
 *     invalidates tokens that have not yet expired.
 *   - Permissions are re-resolved from the database once the token exceeds the
 *     cache TTL, so revoking a role does not wait out the token lifetime.
 */
import type { NextFunction, Request, Response } from 'express';
import { withTenant } from '../db/pool.js';
import { UnauthenticatedError } from '../utils/errors.js';
import { loadUserGrants, type Permission, type Principal, type RoleKey } from '../security/rbac.js';
import { tokenAgeSeconds, verifyAccessToken } from '../security/tokens.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/** Beyond this age, permissions in the token are re-checked against the database. */
const PERMISSION_CACHE_TTL_SECONDS = 120;

function extractBearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;

  return token.trim();
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearer(req);
    if (!token) {
      throw new UnauthenticatedError('Sign in to continue.');
    }

    const claims = verifyAccessToken(token);

    let roles = claims.roles;
    let permissions = claims.perms;
    let identity = { email: '', fullName: '' };

    await withTenant(
      claims.tid,
      async ({ db }) => {
        // Is the session still live? Covers sign-out, admin revocation and the
        // idle timeout required by HIPAA §164.312(a)(2)(iii).
        // The identity fields are read here, not carried in the token, so the
        // audit trail records a readable actor ("Dr. Ada Okafor") rather than a
        // bare UUID — which is the difference between a trail an investigator
        // can follow and one they cannot.
        const { rows } = await db.query<{
          revoked_at: Date | null;
          expires_at: Date;
          last_used_at: Date;
          user_status: string;
          tenant_status: string;
          email: string;
          full_name: string;
        }>(
          `
          SELECT s.revoked_at, s.expires_at, s.last_used_at,
                 u.status AS user_status, t.status AS tenant_status,
                 u.email, u.full_name
            FROM auth_sessions s
            JOIN users u ON u.id = s.user_id
            JOIN tenants t ON t.id = s.tenant_id
           WHERE s.id = $1 AND s.user_id = $2
          `,
          [claims.sid, claims.sub],
        );

        const session = rows[0];
        if (!session) throw new UnauthenticatedError('Your session is no longer valid.');
        if (session.revoked_at) throw new UnauthenticatedError('Your session was signed out.');
        if (session.expires_at <= new Date()) throw new UnauthenticatedError('Your session has expired.');
        if (session.user_status !== 'active') throw new UnauthenticatedError('This account is not active.');
        if (session.tenant_status !== 'active') {
          throw new UnauthenticatedError('This hospital’s account is not currently active.');
        }

        const idleMs = Date.now() - session.last_used_at.getTime();
        if (idleMs > env.SESSION_IDLE_TIMEOUT_MINUTES * 60_000) {
          await db.query(
            `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'idle_timeout' WHERE id = $1`,
            [claims.sid],
          );
          throw new UnauthenticatedError('You were signed out after a period of inactivity.');
        }

        await db.query('UPDATE auth_sessions SET last_used_at = now() WHERE id = $1', [claims.sid]);

        identity = { email: session.email, fullName: session.full_name };

        // Stale token: re-resolve grants so a revoked role takes effect now.
        if (tokenAgeSeconds(claims) > PERMISSION_CACHE_TTL_SECONDS) {
          const fresh = await loadUserGrants(db, claims.sub);
          roles = fresh.roles;
          permissions = fresh.permissions;
        }
      },
      { actorUserId: claims.sub },
    );

    const principal: Principal = {
      userId: claims.sub,
      tenantId: claims.tid,
      email: identity.email,
      fullName: identity.fullName,
      roles: roles as RoleKey[],
      permissions: new Set(permissions as Permission[]),
      staffProfileId: claims.spid ?? null,
      patientId: claims.pid ?? null,
      sessionId: claims.sid,
      facilityIds: claims.fids ?? [],
    };

    req.principal = principal;
    next();
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      logger.debug({ requestId: req.requestId }, 'authentication rejected');
    }
    next(error);
  }
}

/** For routes that behave differently when signed in but do not require it. */
export async function optionalAuthenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!extractBearer(req)) {
    next();
    return;
  }
  await authenticate(req, res, next);
}
