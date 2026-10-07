/**
 * Tokens for the vendor console.
 *
 * Deliberately a separate file with a separate secret rather than an extra
 * claim on the tenant token, and the reason is worth stating plainly: the two
 * realms must not be able to impersonate each other even if a check is one
 * day forgotten.
 *
 * Share one signing key between them and the ONLY thing standing between a
 * hospital receptionist's access token and the cross-tenant console is an
 * `aud` comparison somewhere in a middleware — a single `if` whose removal no
 * test would obviously catch. With distinct keys, a tenant token presented to
 * a platform route fails signature verification before any claim is read, and
 * a mistake in the audience check degrades to nothing at all.
 *
 * The audience claim is checked too. Belt and braces is the right posture for
 * the one credential in this system that crosses tenant boundaries.
 */
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { InternalError, UnauthenticatedError } from '../utils/errors.js';
import { randomToken, sha256 } from './crypto.js';
import { parseDuration } from './tokens.js';

/** The only value this realm's tokens carry, and the only one it accepts. */
const PLATFORM_AUDIENCE = 'hims:platform';

export interface PlatformTokenClaims {
  /** Subject: the platform_users.id. */
  sub: string;
  /** platform_sessions.id, so a token can be revoked before it expires. */
  sid: string;
  email: string;
  isOwner: boolean;
  aud: string;
  iat: number;
  exp: number;
  iss: string;
}

export type PlatformTokenPayload = Pick<PlatformTokenClaims, 'sub' | 'sid' | 'email' | 'isOwner'>;

function secret(): string {
  if (!env.JWT_PLATFORM_SECRET) {
    // Unreachable through a route: the console is not mounted without it.
    // Thrown rather than defaulted, because a default here would be a signing
    // key everyone shares.
    throw new InternalError(new Error('JWT_PLATFORM_SECRET is not configured'));
  }
  return env.JWT_PLATFORM_SECRET;
}

export function signPlatformToken(payload: PlatformTokenPayload): string {
  const options: SignOptions = {
    // Shorter than the tenant token's. This credential can reach every
    // hospital in the deployment, so the window in which a stolen one stays
    // useful is held down harder.
    expiresIn: '10m',
    issuer: env.JWT_ISSUER,
    audience: PLATFORM_AUDIENCE,
    algorithm: 'HS256',
  };
  return jwt.sign(payload, secret(), options);
}

export function verifyPlatformToken(token: string): PlatformTokenClaims {
  try {
    return jwt.verify(token, secret(), {
      issuer: env.JWT_ISSUER,
      audience: PLATFORM_AUDIENCE,
      algorithms: ['HS256'], // Pinned: an unpinned verifier accepts alg:none.
    }) as PlatformTokenClaims;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthenticatedError('Your console session has expired. Please sign in again.');
    }
    throw new UnauthenticatedError('Your console session is not valid. Please sign in again.');
  }
}

export interface PlatformRefreshToken {
  token: string;
  hash: Buffer;
  expiresAt: Date;
}

/**
 * Twelve hours, not seven days.
 *
 * A tenant refresh token lasts a week because a clinician signing in every
 * morning is friction on a ward. An operator signs into the console to do a
 * specific piece of support work, so the same convenience does not apply and
 * the exposure is much larger.
 */
const PLATFORM_REFRESH_TTL = '12h';

export function issuePlatformRefreshToken(): PlatformRefreshToken {
  const token = randomToken(48);
  return {
    token,
    hash: sha256(token),
    expiresAt: new Date(Date.now() + parseDuration(PLATFORM_REFRESH_TTL)),
  };
}

export function hashPlatformRefreshToken(token: string): Buffer {
  return sha256(token);
}

/** Its own cookie name and path, so it is never sent to a tenant route. */
export const PLATFORM_REFRESH_COOKIE = 'hims_prt';

export function platformRefreshCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/platform/auth',
    maxAge: parseDuration(PLATFORM_REFRESH_TTL),
  };
}
