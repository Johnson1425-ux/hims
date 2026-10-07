/**
 * The vendor console's HTTP surface.
 *
 * Mounted at /platform, and only when the deployment has deliberately
 * configured both halves of the realm — see `platformConsoleEnabled`. A
 * deployment that has not asked for cross-tenant access does not get an
 * endpoint capable of it, not even a 401 one.
 *
 * Note what is NOT here: nothing reads a chart, an encounter, a prescription
 * or an invoice line. The console provisions hospitals, moves them between
 * lifecycle states, manages its own operators and reads audit metadata. A
 * support question that genuinely needs clinical data is answered by a named
 * person inside that hospital, under that hospital's own break-glass review
 * — not by a vendor endpoint.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { authenticatePlatform, requirePlatformOwner } from '../../middleware/authenticate-platform.js';
import { body, param, queryParams, validate } from '../../middleware/validate.js';
import { UnauthenticatedError } from '../../utils/errors.js';
import {
  PLATFORM_REFRESH_COOKIE,
  platformRefreshCookieOptions,
} from '../../security/platform-tokens.js';
import * as service from './service.js';
import * as tenants from './tenants.js';
import * as audit from './audit.js';
import {
  acceptInviteSchema,
  auditQuerySchema,
  breakGlassQuerySchema,
  inviteOperatorSchema,
  listTenantsSchema,
  operatorStatusSchema,
  platformLoginSchema,
  provisionTenantSchema,
  tenantStatusSchema,
  tenantTierSchema,
} from './schemas.js';

export const platformRoutes = Router();

const tenantParams = z.object({ tenantId: z.string().uuid() });
const operatorParams = z.object({ operatorId: z.string().uuid() });

function meta(req: Request): service.RequestMeta {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent')?.slice(0, 500) ?? null,
    requestId: req.requestId ?? null,
  };
}

function issue(res: Response, session: service.PlatformSession): void {
  res.cookie(PLATFORM_REFRESH_COOKIE, session.refreshToken, platformRefreshCookieOptions());
  res.json({
    data: {
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      operator: session.operator,
    },
  });
}

/* ---------------------------------------------------------------------------
 * Authentication (unauthenticated by definition)
 * ------------------------------------------------------------------------- */

platformRoutes.post(
  '/auth/login',
  validate({ body: platformLoginSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, platformLoginSchema);
      issue(res, await service.login(input.email, input.password, meta(req)));
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.post('/auth/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.[PLATFORM_REFRESH_COOKIE] as string | undefined;
    if (!token) throw new UnauthenticatedError('Please sign in to the console again.');

    issue(res, await service.refresh(token, meta(req)));
  } catch (error) {
    // A failed refresh must clear the stale cookie, or the client loops.
    res.clearCookie(PLATFORM_REFRESH_COOKIE, platformRefreshCookieOptions());
    next(error);
  }
});

platformRoutes.post(
  '/auth/accept-invite',
  validate({ body: acceptInviteSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, acceptInviteSchema);
      issue(res, await service.acceptInvite(input.token, input.password, meta(req)));
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.post(
  '/auth/logout',
  authenticatePlatform,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await service.logout(req.platformPrincipal!, meta(req));
      res.clearCookie(PLATFORM_REFRESH_COOKIE, platformRefreshCookieOptions());
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);

/* ---------------------------------------------------------------------------
 * Everything below requires a console session
 * ------------------------------------------------------------------------- */

platformRoutes.use(authenticatePlatform);

platformRoutes.get('/me', (req: Request, res: Response) => {
  res.json({ data: req.platformPrincipal });
});

platformRoutes.get('/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await audit.platformSummary() });
  } catch (error) {
    next(error);
  }
});

platformRoutes.get('/audit/chain', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await audit.verifyAuditChain() });
  } catch (error) {
    next(error);
  }
});

/* ---- Hospitals ----------------------------------------------------------- */

platformRoutes.get(
  '/tenants',
  validate({ query: listTenantsSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = queryParams(req, listTenantsSchema);
      const { rows, total } = await tenants.listTenants(input);
      res.json({ data: rows, meta: { total, page: input.page, pageSize: input.pageSize } });
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.post(
  '/tenants',
  validate({ body: provisionTenantSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, provisionTenantSchema);
      const result = await tenants.provisionTenant(input, req.platformPrincipal!, meta(req));
      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.get(
  '/tenants/:tenantId',
  validate({ params: tenantParams }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = await tenants.getTenant(param(req, 'tenantId'));
      if (!tenant) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'That hospital could not be found.', requestId: req.requestId },
        });
        return;
      }
      res.json({ data: tenant });
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.patch(
  '/tenants/:tenantId/status',
  validate({ params: tenantParams, body: tenantStatusSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, tenantStatusSchema);
      const data = await tenants.setTenantStatus(
        param(req, 'tenantId'),
        input.status,
        input.reason,
        req.platformPrincipal!,
        meta(req),
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.patch(
  '/tenants/:tenantId/plan',
  validate({ params: tenantParams, body: tenantTierSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, tenantTierSchema);
      const data = await tenants.setTenantTier(
        param(req, 'tenantId'),
        input.subscriptionTier,
        input.reason,
        req.platformPrincipal!,
        meta(req),
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

/* ---- Operators ----------------------------------------------------------- */

platformRoutes.get('/operators', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await service.listOperators() });
  } catch (error) {
    next(error);
  }
});

platformRoutes.post(
  '/operators',
  requirePlatformOwner,
  validate({ body: inviteOperatorSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, inviteOperatorSchema);
      const data = await service.inviteOperator(input, req.platformPrincipal!, meta(req));
      res.status(201).json({ data });
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.patch(
  '/operators/:operatorId',
  requirePlatformOwner,
  validate({ params: operatorParams, body: operatorStatusSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, operatorStatusSchema);
      const data = await service.setOperatorStatus(
        param(req, 'operatorId'),
        input.status,
        req.platformPrincipal!,
        meta(req),
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

/* ---- Oversight ----------------------------------------------------------- */

platformRoutes.get(
  '/audit',
  validate({ query: auditQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = queryParams(req, auditQuerySchema);
      const { rows, total } = await audit.listAuditEvents(input);
      res.json({ data: rows, meta: { total, page: input.page, pageSize: input.pageSize } });
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.get(
  '/break-glass',
  validate({ query: breakGlassQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = queryParams(req, breakGlassQuerySchema);
      const { rows, total } = await audit.listBreakGlass(input);
      res.json({ data: rows, meta: { total, page: input.page, pageSize: input.pageSize } });
    } catch (error) {
      next(error);
    }
  },
);
