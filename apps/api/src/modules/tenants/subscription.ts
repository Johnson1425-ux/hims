/**
 * What the hospital can see of its own subscription.
 *
 * The mirror of the console's billing module, and deliberately much smaller:
 * a hospital reads its plan, what it owes and its invoices, and changes
 * nothing. Terms are a contract between two companies, not a setting.
 *
 * NO BYPASSRLS HERE, and that is the whole reason this file exists rather
 * than reusing the console's queries. These routes run on the ordinary
 * tenant connection, so the SELECT-only policies migration 0018 put on
 * `tenant_subscriptions`, `subscription_invoices` and
 * `subscription_payments` do the scoping — a hospital cannot name another
 * hospital's invoice id and get anything back, because the row is not
 * visible to the transaction at all. The console's own reads need the
 * privileged pool precisely because they span tenants; these must not.
 *
 * Gated on `tenant:settings`: what a hospital pays its software vendor is an
 * administrative matter, not something a clinician or a receptionist needs
 * on screen.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { param, validate } from '../../middleware/validate.js';
import { runInTenantReadOnly } from '../../middleware/tenant.js';
import {
  CUSTOMER_INVOICE_PAYMENTS_SQL,
  renderInvoicePdf,
  type InvoiceDocument,
  type InvoicePayment,
} from '../platform/invoice-pdf.js';
import { NotFoundError } from '../../utils/errors.js';

export const subscriptionRoutes = Router();

const invoiceParams = z.object({ invoiceId: z.string().uuid() });

/**
 * The plan, the money owed, and the invoice history in one call.
 *
 * One round trip because the page renders all of it together and a
 * hospital's invoice list is a few dozen rows at most — paginating it would
 * be ceremony.
 */
subscriptionRoutes.get(
  '/',
  requirePermission('tenant:settings'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await runInTenantReadOnly(req, async ({ db, tenantId }) => {
        const { rows: subscriptions } = await db.query<Record<string, unknown>>(
          `SELECT s.currency, s.billing_interval, s.current_period_start, s.current_period_end,
                  s.trial_ends_on, s.status,
                  t.subscription_tier AS tier,
                  -- WHAT THIS HOSPITAL PAYS, and deliberately not read from
                  -- the price book. The tenant role has no SELECT on
                  -- subscription_plans — the vendor's full price list, for
                  -- every tier and every customer, is none of one hospital's
                  -- business, and granting it here to populate one number
                  -- would hand over the lot.
                  --
                  -- Two sources that ARE theirs: a negotiated rate on their
                  -- own subscription row, or failing that the amount on the
                  -- last invoice they were actually sent. The second is the
                  -- better answer anyway — it is what they have been charged
                  -- rather than what a table says they should be.
                  COALESCE(
                    s.amount_cents,
                    (SELECT i.amount_cents FROM subscription_invoices i
                      WHERE i.tenant_id = s.tenant_id AND i.status <> 'void'
                      ORDER BY i.issued_on DESC, i.invoice_number DESC
                      LIMIT 1)
                  ) AS amount_cents
             FROM tenant_subscriptions s
             JOIN tenants t ON t.id = s.tenant_id
            WHERE s.tenant_id = $1`,
          [tenantId],
        );

        // `v_subscription_invoice_status` is security_invoker, so the policy
        // applies through it and this cannot return another tenant's rows.
        const { rows: invoices } = await db.query<Record<string, unknown>>(
          `SELECT id, invoice_number, tier, period_start, period_end, currency,
                  amount_cents, tax_cents, total_cents, amount_paid_cents, balance_cents,
                  status, is_overdue, days_overdue, issued_on, due_on, void_reason
             FROM v_subscription_invoice_status
            ORDER BY issued_on DESC, invoice_number DESC
            LIMIT 60`,
        );

        const outstanding = invoices
          .filter((i) => i.status === 'issued' || i.status === 'partially_paid')
          .reduce((sum, i) => sum + Number(i.balance_cents), 0);

        const overdue = invoices
          .filter((i) => i.is_overdue)
          .reduce((sum, i) => sum + Number(i.balance_cents), 0);

        return {
          subscription: subscriptions[0] ?? null,
          invoices,
          outstanding_cents: outstanding,
          overdue_cents: overdue,
        };
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * The hospital's own copy of an invoice.
 *
 * Declared before any route that could match a bare `:invoiceId` — Express
 * matches in order and a bare parameter swallows "<uuid>.pdf", which is how
 * the console's equivalent route was briefly unreachable.
 *
 * No signed token: this caller has a session. The emailed link exists for
 * the person reading their inbox, and the two paths deliberately do not
 * share an authorisation mechanism.
 */
subscriptionRoutes.get(
  '/invoices/:invoiceId.pdf',
  requirePermission('tenant:settings'),
  validate({ params: invoiceParams }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoiceId = param(req, 'invoiceId');

      const invoice = await runInTenantReadOnly(req, async ({ db }) => {
        const { rows } = await db.query<InvoiceDocument>(
          `SELECT i.invoice_number, i.tier, i.period_start, i.period_end, i.currency,
                  i.amount_cents, i.tax_cents, i.total_cents, i.amount_paid_cents,
                  i.balance_cents, i.status, i.issued_on, i.due_on, i.notes,
                  t.display_name AS tenant_name, t.slug AS tenant_slug
             FROM v_subscription_invoice_status i
             JOIN tenants t ON t.id = i.tenant_id
            WHERE i.id = $1`,
          [invoiceId],
        );

        const row = rows[0];
        if (!row) return null;

        // Same transaction, same policy: a payment belonging to another
        // hospital is filtered out by RLS exactly as the invoice would be.
        const { rows: payments } = await db.query<InvoicePayment>(
          CUSTOMER_INVOICE_PAYMENTS_SQL,
          [invoiceId],
        );

        return { ...row, payments };
      });

      // Another hospital's invoice is invisible rather than forbidden: the
      // policy filtered it out, so from here it genuinely does not exist.
      if (!invoice) throw new NotFoundError('invoice');

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
