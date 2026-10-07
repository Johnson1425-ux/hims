/**
 * Authentication for the vendor console.
 *
 * Separate from `authenticate` on purpose, and the separation is structural
 * rather than stylistic: this middleware never touches `users`,
 * `auth_sessions` or `req.principal`, and the tenant middleware never touches
 * `platform_users` or `req.platformPrincipal`. There is no code path on which
 * a hospital credential and a console credential are compared against the
 * same table, so one cannot be mistaken for the other.
 *
 * The session row is re-read on every request, as it is on the tenant path.
 * For a credential that can reach every hospital in the deployment, "signing
 * out takes effect immediately" is not a nicety.
 */
import type { NextFunction, Request, Response } from 'express';
import { withoutTenantIsolation } from '../db/pool.js';
import { ForbiddenError, UnauthenticatedError } from '../utils/errors.js';
import { verifyPlatformToken } from '../security/platform-tokens.js';
import { logger } from '../utils/logger.js';

export interface PlatformPrincipal {
  operatorId: string;
  email: string;
  fullName: string;
  isOwner: boolean;
  sessionId: string;
}

function extractBearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;

  return token.trim();
}

export async function authenticatePlatform(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractBearer(req);
    if (!token) {
      throw new UnauthenticatedError('Sign in to the console to continue.');
    }

    // Wrong-realm tokens die here: a tenant token is signed with a different
    // key, so this throws before a single claim is trusted.
    const claims = verifyPlatformToken(token);

    const operator = await withoutTenantIsolation(
      'platform console: resolving the operator behind a request',
      async (db) => {
        const { rows } = await db.query<{
          id: string;
          email: string;
          full_name: string;
          is_owner: boolean;
          status: string;
          session_revoked_at: Date | null;
          session_expires_at: Date;
        }>(
          `SELECT u.id, u.email, u.full_name, u.is_owner, u.status,
                  s.revoked_at AS session_revoked_at, s.expires_at AS session_expires_at
             FROM platform_sessions s
             JOIN platform_users u ON u.id = s.platform_user_id
            WHERE s.id = $1 AND s.platform_user_id = $2`,
          [claims.sid, claims.sub],
        );

        return rows[0] ?? null;
      },
    );

    if (!operator) {
      throw new UnauthenticatedError('Please sign in to the console again.');
    }

    // A revoked session must stop working now, not at token expiry.
    if (operator.session_revoked_at || operator.session_expires_at <= new Date()) {
      throw new UnauthenticatedError('Your console session has ended. Please sign in again.');
    }

    if (operator.status !== 'active') {
      logger.warn(
        { operatorId: operator.id, status: operator.status },
        'a suspended operator presented a live console token',
      );
      throw new ForbiddenError('This operator account is not active.');
    }

    req.platformPrincipal = {
      operatorId: operator.id,
      email: operator.email,
      fullName: operator.full_name,
      isOwner: operator.is_owner,
      sessionId: claims.sid,
    };

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Guard the handful of actions reserved to an owner: minting and removing
 * other operators. An ordinary operator can do support work on tenants;
 * changing who holds the keys to the console is a different kind of act.
 */
export function requirePlatformOwner(req: Request, _res: Response, next: NextFunction): void {
  if (!req.platformPrincipal) {
    next(new UnauthenticatedError('Sign in to the console to continue.'));
    return;
  }

  if (!req.platformPrincipal.isOwner) {
    next(new ForbiddenError('Only a console owner can change operator accounts.'));
    return;
  }

  next();
}
