/**
 * JWT issuance and verification.
 *
 * ACCESS TOKEN  — short-lived (15 min), carries the permission set so the hot
 *   path needs no database round-trip for authorisation. The cost of caching
 *   permissions in a token is that a revoked role stays live for up to one TTL,
 *   which is why the TTL is short and why `tokenAgeSeconds` is exposed: routes
 *   touching PHI re-resolve grants from the database when the token is stale.
 *
 * REFRESH TOKEN — long-lived (7 days), opaque to the client, stored as a
 *   SHA-256 digest in `auth_sessions` so a database leak cannot mint sessions.
 *   Rotated on every use, with reuse detection: presenting a token that has
 *   already been rotated revokes the entire session family, which is the
 *   standard defence against a stolen refresh token.
 */
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { UnauthenticatedError } from '../utils/errors.js';
import { randomToken, sha256 } from './crypto.js';
import type { Permission, RoleKey } from './rbac.js';

export interface AccessTokenClaims {
  /** Subject: the user id. */
  sub: string;
  tid: string;                 // tenant id
  sid: string;                 // auth_sessions.id, so a token can be revoked
  roles: RoleKey[];
  perms: Permission[];
  /** Staff profile id, when the user is a clinician. */
  spid?: string | null;
  /** Patient id, when the user is a portal account. */
  pid?: string | null;
  /** Facility-scoped grants; empty means tenant-wide. */
  fids?: string[];
  iat: number;
  exp: number;
  iss: string;
}

export type AccessTokenPayload = Omit<AccessTokenClaims, 'iat' | 'exp' | 'iss'>;

export function signAccessToken(payload: AccessTokenPayload): string {
  const options: SignOptions = {
    expiresIn: env.JWT_ACCESS_TTL as SignOptions['expiresIn'],
    issuer: env.JWT_ISSUER,
    algorithm: 'HS256',
  };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: env.JWT_ISSUER,
      algorithms: ['HS256'], // Pinned: an unpinned verifier accepts alg:none.
    }) as AccessTokenClaims;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthenticatedError('Your session has expired. Please sign in again.');
    }
    throw new UnauthenticatedError('Your session is not valid. Please sign in again.');
  }
}

/** Seconds since the token was issued; drives the permission re-check. */
export function tokenAgeSeconds(claims: AccessTokenClaims): number {
  return Math.max(0, Math.floor(Date.now() / 1000) - claims.iat);
}

export interface RefreshToken {
  /** Returned to the client once, never stored in this form. */
  token: string;
  /** SHA-256 digest, which is what goes in auth_sessions.refresh_token_hash. */
  hash: Buffer;
  expiresAt: Date;
}

export function issueRefreshToken(): RefreshToken {
  const token = randomToken(48);
  return {
    token,
    hash: sha256(token),
    expiresAt: new Date(Date.now() + parseDuration(env.JWT_REFRESH_TTL)),
  };
}

export function hashRefreshToken(token: string): Buffer {
  return sha256(token);
}

/** Parse "15m", "7d", "12h", "30s" into milliseconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    throw new Error(`cannot parse duration "${value}"; use forms like 15m, 12h, 7d`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  return amount * multipliers[unit as keyof typeof multipliers];
}

/**
 * Cookie options for the refresh token.
 *
 * httpOnly keeps it away from XSS; sameSite=strict blocks CSRF on the refresh
 * endpoint; the path restriction means it is not attached to ordinary API
 * calls, so it is exposed on exactly one route.
 */
export function refreshCookieOptions(): {
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
    path: '/api/v1/auth',
    maxAge: parseDuration(env.JWT_REFRESH_TTL),
  };
}

export const REFRESH_COOKIE_NAME = 'hims_rt';
