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

/**
 * How stale `auth_sessions.last_used_at` may get before a request rewrites it.
 *
 * It exists to drive the idle timeout, which is measured in minutes, and the
 * slack falls on the safe side: a lagging timestamp makes a session look idle
 * sooner, so the timeout can fire up to this long EARLY and never late. In
 * exchange, a page that fires six requests at once performs one write instead
 * of six serialised ones on the same row.
 */
const SESSION_TOUCH_INTERVAL_SECONDS = 60;

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
    let idleTimedOut = false;

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
          // Recorded, not written here. withTenant rolls back when the callback
          // throws, so revoking the session and then throwing in the same
          // transaction discarded the revocation — see below.
          idleTimedOut = true;
          return;
        }

        // Touching this on EVERY request is what made the app feel slow: one
        // page issues several requests at once, they all target the same
        // session row, and each UPDATE waits for the previous one's row lock —
        // so the writes serialise and the page waits for all of them.
        //
        // The value only has to be accurate to within the idle-timeout
        // granularity, so the predicate makes a request that already touched
        // the row recently match no rows at all. A no-op UPDATE takes no row
        // lock, which is what removes the contention rather than merely
        // shortening it.
        await db.query(
          `UPDATE auth_sessions
              SET last_used_at = now()
            WHERE id = $1
              AND last_used_at < now() - make_interval(secs => $2)`,
          [claims.sid, SESSION_TOUCH_INTERVAL_SECONDS],
        );

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

    if (idleTimedOut) {
      // A separate transaction, because this write has to OUTLIVE the failure
      // it describes. Done inside the block above it was rolled back with
      // everything else, which left revoked_at NULL — so the automatic logoff
      // required by §164.312(a)(2)(iii) was never recorded, an administrator
      // reviewing sessions still saw an active one, and, worse, the refresh
      // path checks revoked_at but not idleness: the browser's automatic
      // refresh would mint a fresh access token for a session that had already
      // timed out.
      try {
        await withTenant(
          claims.tid,
          async ({ db }) => {
            await db.query(
              `UPDATE auth_sessions
                  SET revoked_at = now(), revoked_reason = 'idle_timeout'
                WHERE id = $1 AND revoked_at IS NULL`,
              [claims.sid],
            );
          },
          { actorUserId: claims.sub },
        );
      } catch (error) {
        // The request is rejected either way — a failure to record the
        // revocation must never leave the session usable — but a session that
        // stays open in the database is exactly what an auditor would ask
        // about, so it is logged loudly rather than swallowed.
        logger.error(
          { err: error, sessionId: claims.sid, userId: claims.sub },
          'could not record idle-timeout revocation; the session is still open in the database',
        );
      }

      throw new UnauthenticatedError('You were signed out after a period of inactivity.');
    }

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
