/**
 * Rate limiting.
 *
 * Tiered, because the threats differ. Login is throttled per email+IP to slow
 * credential stuffing without letting one attacker lock out a whole hospital's
 * NAT address. Patient search is throttled because it is the endpoint an
 * insider would use to enumerate a celebrity's chart. Everything else gets a
 * generous default that only catches runaway clients.
 *
 * In production this is backed by Redis, so limits hold across instances; the
 * in-memory store below is for single-process development only.
 */
import rateLimit, { type Options } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { isProduction, isTest } from '../config/env.js';
import { logger } from '../utils/logger.js';

function handler(req: Request, res: Response): void {
  logger.warn(
    { ip: req.ip, path: req.path, userId: req.principal?.userId, requestId: req.requestId },
    'rate limit exceeded',
  );

  res.status(429).json({
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please wait a moment and try again.',
      requestId: req.requestId,
    },
  });
}

const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
  // Tests would otherwise fail intermittently on the limiter rather than the
  // behaviour under test.
  skip: () => isTest,
};

/** Default ceiling for authenticated API traffic. */
export const apiLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 300,
  // Per user when signed in, per IP otherwise: a busy ward behind one NAT
  // address must not throttle itself.
  keyGenerator: (req) => req.principal?.userId ?? req.ip ?? 'unknown',
});

/**
 * Login. Keyed on email AND IP so that:
 *   - spraying one password across many accounts from one IP is caught,
 *   - and hammering one account from many IPs is caught by the per-account
 *     lockout in the auth service, not here.
 */
export const loginLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60_000,
  limit: isProduction ? 10 : 100,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : 'no-email';
    return `${req.ip ?? 'unknown'}:${email}`;
  },
});

/** Password reset and invitation resends: throttled to prevent mail bombing. */
export const passwordResetLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 60_000,
  limit: 5,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : 'no-email';
    return `reset:${email}`;
  },
});

/**
 * Patient search. The classic insider-abuse endpoint: one lookup is care,
 * four hundred in an hour is a browsing expedition. The limit is deliberately
 * well above legitimate front-desk volume, so it catches scripted enumeration
 * rather than a busy receptionist.
 */
export const patientSearchLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 60_000,
  limit: 400,
  keyGenerator: (req) => `search:${req.principal?.userId ?? req.ip ?? 'unknown'}`,
});

/** Bulk export: the data-exfiltration path. Deliberately tight. */
export const exportLimiter = rateLimit({
  ...shared,
  windowMs: 24 * 60 * 60_000,
  limit: 20,
  keyGenerator: (req) => `export:${req.principal?.userId ?? req.ip ?? 'unknown'}`,
});
