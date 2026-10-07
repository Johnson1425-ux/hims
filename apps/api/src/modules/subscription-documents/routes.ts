/**
 * The one public route in the system, and the only one.
 *
 * It serves a subscription invoice PDF to whoever holds a signed link —
 * no session, because the recipient is clicking from a mail client and has
 * neither a bearer token nor a cookie for this origin. See
 * `security/download-tokens.ts` for why that trade is acceptable for this
 * document and would not be for any other.
 *
 * Mounted OUTSIDE the tenant router and before any `authenticate`, which is
 * deliberate and should stay visible: a reviewer scanning the module list
 * should see exactly one router that does not start with authentication, and
 * be able to read the whole thing in a minute.
 *
 * What it will not do:
 *   - It serves no other document type. One route, one resource.
 *   - It never trusts the id in the path on its own: the signed tenant is
 *     checked against the row, so a token cannot be pointed at a different
 *     hospital's invoice.
 *   - It is rate limited like everything else, since the token is guessable
 *     only by brute force and brute force should be expensive.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { withoutTenantIsolation } from '../../db/pool.js';
import { validate, param } from '../../middleware/validate.js';
import { AppError } from '../../utils/errors.js';
import { verifyInvoiceDownload } from '../../security/download-tokens.js';
import { renderInvoicePdf, type InvoiceDocument } from '../platform/invoice-pdf.js';
import { logger } from '../../utils/logger.js';

export const subscriptionDocumentRoutes = Router();

// `:invoiceId.pdf` so the file saves with a sensible name and extension when
// a browser downloads it, rather than a bare uuid.
const params = z.object({ invoiceId: z.string().uuid() });

subscriptionDocumentRoutes.get(
  '/:invoiceId.pdf',
  validate({ params }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoiceId = param(req, 'invoiceId');
      const claims = verifyInvoiceDownload(
        typeof req.query.token === 'string' ? req.query.token : undefined,
      );

      // One message for a bad token, an expired one and a wrong invoice: a
      // caller has no legitimate use for the distinction.
      const refuse = () => {
        throw new AppError(
          403,
          'FORBIDDEN',
          'This invoice link is not valid or has expired. Ask for a new one.',
        );
      };

      if (!claims || claims.invoiceId !== invoiceId) refuse();

      const invoice = await withoutTenantIsolation(
        'subscription invoice download from a signed link',
        async (db) => {
          const { rows } = await db.query<InvoiceDocument & { tenant_id: string }>(
            `SELECT i.invoice_number, i.tier, i.period_start, i.period_end, i.currency,
                    i.amount_cents, i.tax_cents, i.total_cents, i.amount_paid_cents,
                    i.balance_cents, i.status, i.issued_on, i.due_on, i.notes,
                    i.tenant_id, t.display_name AS tenant_name, t.slug AS tenant_slug
               FROM v_subscription_invoice_status i
               JOIN tenants t ON t.id = i.tenant_id
              WHERE i.id = $1`,
            [invoiceId],
          );

          return rows[0] ?? null;
        },
      );

      // The signed tenant must match the row. Belt and braces over the
      // signature, and the thing that makes a swapped id useless.
      if (!invoice || invoice.tenant_id !== claims!.tenantId) refuse();

      const pdf = await renderInvoicePdf(invoice!);

      logger.info(
        { invoiceId, tenantId: invoice!.tenant_id, ip: req.ip },
        'subscription invoice downloaded from a signed link',
      );

      res
        .status(200)
        .setHeader('Content-Type', 'application/pdf')
        .setHeader('Content-Length', String(pdf.length))
        .setHeader(
          'Content-Disposition',
          `inline; filename="${invoice!.invoice_number}.pdf"`,
        )
        // A signed link may sit in a mail archive; a shared cache must not
        // keep a copy of somebody's invoice.
        .setHeader('Cache-Control', 'private, no-store')
        .end(pdf);
    } catch (error) {
      next(error);
    }
  },
);
