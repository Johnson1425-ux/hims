/**
 * HTTP security headers.
 *
 * `no-store` on every API response is the one worth explaining: a shared
 * workstation at a nurses' station must not serve the previous user's chart
 * out of the browser's back-forward cache.
 */
import helmet from 'helmet';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env, isProduction } from '../config/env.js';

export function securityHeaders(): RequestHandler[] {
  return [
    helmet({
      // The API serves JSON, so a restrictive policy costs nothing here. The
      // web app sets its own CSP, which has to allow its bundles.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    }),

    (_req: Request, res: Response, next: NextFunction) => {
      // No intermediary or browser may retain a response containing PHI.
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
      // Deny the browser APIs an API has no use for.
      res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
      next();
    },
  ];
}

export const corsOptions = {
  origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void {
    // Same-origin and server-to-server calls arrive without an Origin header.
    if (!origin) {
      callback(null, true);
      return;
    }

    if (env.CORS_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin not allowed'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Tenant-Slug', 'Idempotency-Key'],
  exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  maxAge: 600,
};
