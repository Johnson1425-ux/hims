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
import * as billing from './billing.js';
import { renderInvoicePdf, type InvoiceDocument } from './invoice-pdf.js';
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
  updatePlanSchema,
  setSubscriptionSchema,
  listInvoicesSchema,
  recordPaymentSchema,
  voidSchema,
} from './schemas.js';

export const platformRoutes = Router();

const tenantParams = z.object({ tenantId: z.string().uuid() });
const operatorParams = z.object({ operatorId: z.string().uuid() });
const planParams = z.object({ planId: z.string().uuid() });
const invoiceParams = z.object({ invoiceId: z.string().uuid() });
const paymentParams = z.object({ paymentId: z.string().uuid() });

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


/* ---- Subscription billing ------------------------------------------------ */
/*
 * The vendor's own books: what each hospital owes for the software. Entirely
 * separate from /billing, which is what a patient owes a hospital.
 *
 * Reading is open to any operator; so is issuing and recording payment, since
 * that is the support work the console exists for. Nothing here is owner-only
 * — an owner's extra authority is over who holds console access, not over
 * money.
 */

platformRoutes.get('/billing/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await billing.revenueSummary() });
  } catch (error) {
    next(error);
  }
});

platformRoutes.get('/billing/plans', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await billing.listPlans() });
  } catch (error) {
    next(error);
  }
});

platformRoutes.patch(
  '/billing/plans/:planId',
  validate({ params: planParams, body: updatePlanSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await billing.updatePlan(
        param(req, 'planId'),
        body(req, updatePlanSchema),
        req.platformPrincipal!,
        meta(req),
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

/** What the next run WOULD issue. Looked at before pressing the button. */
platformRoutes.get('/billing/due', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await billing.previewDue() });
  } catch (error) {
    next(error);
  }
});

platformRoutes.post('/billing/run', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await billing.issueDueInvoices(req.platformPrincipal!, meta(req));
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

platformRoutes.get(
  '/billing/invoices',
  validate({ query: listInvoicesSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = queryParams(req, listInvoicesSchema);
      const { rows, total } = await billing.listInvoices(input);
      res.json({ data: rows, meta: { total, page: input.page, pageSize: input.pageSize } });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * The same PDF the hospital receives, for an operator who needs to re-send
 * it or answer a question about it. Authenticated normally — an operator has
 * a session, so none of the signed-link machinery applies here.
 */
platformRoutes.get(
  '/billing/invoices/:invoiceId.pdf',
  validate({ params: invoiceParams }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoice = (await billing.getInvoice(param(req, 'invoiceId'))) as
        | (InvoiceDocument & { invoice_number: string })
        | null;

      if (!invoice) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'That invoice could not be found.', requestId: req.requestId },
        });
        return;
      }

      const pdf = await renderInvoicePdf(invoice);

      res
        .status(200)
        .setHeader('Content-Type', 'application/pdf')
        .setHeader('Content-Length', String(pdf.length))
        .setHeader('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`)
        .setHeader('Cache-Control', 'private, no-store')
        .end(pdf);
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.get(
  '/billing/invoices/:invoiceId',
  validate({ params: invoiceParams }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoice = await billing.getInvoice(param(req, 'invoiceId'));
      if (!invoice) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'That invoice could not be found.', requestId: req.requestId },
        });
        return;
      }
      res.json({ data: invoice });
    } catch (error) {
      next(error);
    }
  },
);

/** The signed link that was emailed, so an operator can re-send it. */
platformRoutes.get(
  '/billing/invoices/:invoiceId/link',
  validate({ params: invoiceParams }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await billing.downloadLink(param(req, 'invoiceId'));
      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.post(
  '/billing/invoices/:invoiceId/payments',
  validate({ params: invoiceParams, body: recordPaymentSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await billing.recordPayment(
        param(req, 'invoiceId'),
        body(req, recordPaymentSchema),
        req.platformPrincipal!,
        meta(req),
      );
      res.status(201).json({ data });
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.post(
  '/billing/invoices/:invoiceId/void',
  validate({ params: invoiceParams, body: voidSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await billing.voidInvoice(
        param(req, 'invoiceId'),
        body(req, voidSchema).reason,
        req.platformPrincipal!,
        meta(req),
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.post(
  '/billing/payments/:paymentId/void',
  validate({ params: paymentParams, body: voidSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await billing.voidPayment(
        param(req, 'paymentId'),
        body(req, voidSchema).reason,
        req.platformPrincipal!,
        meta(req),
      );
      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.get(
  '/tenants/:tenantId/subscription',
  validate({ params: tenantParams }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ data: await billing.getSubscription(param(req, 'tenantId')) });
    } catch (error) {
      next(error);
    }
  },
);

platformRoutes.put(
  '/tenants/:tenantId/subscription',
  validate({ params: tenantParams, body: setSubscriptionSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await billing.setSubscription(
        param(req, 'tenantId'),
        body(req, setSubscriptionSchema),
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
