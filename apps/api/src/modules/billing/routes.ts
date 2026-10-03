/**
 * Billing, invoicing and insurance claims.
 *
 * Money is integer cents throughout, and invoice totals are never written by
 * this code: the `trg_invoice_lines_sync` trigger derives them from the lines,
 * so the header and the lines cannot disagree. See
 * migrations/0007_billing_and_claims.sql.
 */
import { Router } from 'express';
import { z } from 'zod';
import { booleanish } from '../../utils/schema.js';
import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireStaffAccount } from '../../middleware/authorize.js';
import { body, queryParams, validate } from '../../middleware/validate.js';
import { runInTenant, runInTenantReadOnly } from '../../middleware/tenant.js';
import { assertPatientAccess } from '../../security/rbac.js';
import { AppError, NotFoundError } from '../../utils/errors.js';

export const billingRoutes = Router();
billingRoutes.use(authenticate, requireStaffAccount());

const createInvoiceSchema = z.object({
  patientId: z.string().uuid(),
  encounterId: z.string().uuid().optional(),
  appointmentId: z.string().uuid().optional(),
  facilityId: z.string().uuid().optional(),
  dueInDays: z.coerce.number().int().min(0).max(365).default(30),
  lines: z
    .array(
      z.object({
        serviceItemId: z.string().uuid().optional(),
        description: z.string().min(1).max(300),
        cptCode: z.string().max(16).optional(),
        quantity: z.coerce.number().positive().default(1),
        unitPriceCents: z.coerce.number().int().min(0).optional(),
        discountCents: z.coerce.number().int().min(0).default(0),
        diagnosisCodes: z.array(z.string().max(16)).max(12).default([]),
        sourceKind: z
          .enum(['appointment', 'encounter', 'prescription', 'diagnostic_order', 'dispense', 'manual'])
          .default('manual'),
        sourceId: z.string().uuid().optional(),
      }),
    )
    .min(1, 'An invoice needs at least one line.')
    .max(200),
  notes: z.string().max(1000).optional(),
});

const recordPaymentSchema = z.object({
  invoiceId: z.string().uuid(),
  amountCents: z.coerce.number().int().positive('A payment must be greater than zero.'),
  method: z.enum([
    'cash', 'card', 'bank_transfer', 'mobile_money', 'cheque',
    'insurance_remittance', 'credit_note', 'writeoff',
  ]),
  payerKind: z.enum(['patient', 'insurance', 'employer', 'ngo', 'government', 'other']).default('patient'),
  payerId: z.string().uuid().optional(),
  gatewayReference: z.string().max(200).optional(),
  cardLast4: z.string().length(4).optional(),
  notes: z.string().max(500).optional(),
});

const submitClaimSchema = z.object({
  invoiceId: z.string().uuid(),
  policyId: z.string().uuid(),
  priorAuthNumber: z.string().max(80).optional(),
  submissionFormat: z.enum(['x12_837p', 'x12_837i', 'portal', 'paper']).default('x12_837p'),
});

const invoiceQuerySchema = z.object({
  patientId: z.string().uuid().optional(),
  status: z.string().max(40).optional(),
  billingStage: z.string().max(40).optional(),
  overdueOnly: booleanish().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Create an invoice.
 *
 * Prices are SNAPSHOTTED onto each line from the catalogue at billing time.
 * Reading the price through a join at render time would mean an issued invoice
 * silently changes when someone edits the price list next month — which is
 * both a reconciliation defect and, where the invoice has been sent, a legal
 * problem.
 */
billingRoutes.post(
  '/invoices',
  requirePermission('invoice:write'),
  validate({ body: createInvoiceSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, createInvoiceSchema);

      const result = await runInTenant(req, async ({ db, tenantId }, collect) => {
        const principal = req.principal!;
        await assertPatientAccess(db, principal, input.patientId);

        // Coordination of benefits: the primary policy drives the payer split.
        const { rows: policies } = await db.query<{ id: string; copay_cents: number | null; coinsurance_rate: string | null }>(
          `SELECT id, copay_cents, coinsurance_rate
             FROM patient_insurance_policies
            WHERE patient_id = $1 AND is_active AND precedence = 1
              AND (expires_on IS NULL OR expires_on >= CURRENT_DATE)
            LIMIT 1`,
          [input.patientId],
        );
        const policy = policies[0];

        const { rows: created } = await db.query<{ id: string; invoice_number: string }>(
          `INSERT INTO invoices (tenant_id, invoice_number, patient_id, encounter_id, appointment_id,
                                 facility_id, issued_on, due_on, status, billing_stage,
                                 primary_policy_id, notes, created_by)
           VALUES ($1, hims_util.allocate_reference($1, 'invoice', 'INV'), $2, $3, $4,
                   $5, CURRENT_DATE, CURRENT_DATE + $6, 'draft',
                   CASE WHEN $7::uuid IS NULL THEN 'patient_responsibility' ELSE 'ready_to_bill' END,
                   $7, $8, $9)
           RETURNING id, invoice_number`,
          [
            tenantId,
            input.patientId,
            input.encounterId ?? null,
            input.appointmentId ?? null,
            input.facilityId ?? null,
            input.dueInDays,
            policy?.id ?? null,
            input.notes ?? null,
            principal.userId,
          ],
        );

        const invoiceId = created[0]!.id;

        for (const [index, line] of input.lines.entries()) {
          // Resolve the price: a payer-negotiated rate beats list price, and an
          // explicitly supplied price beats both (for a quoted or adjusted item).
          const { rows: priced } = await db.query<{
            unit_price_cents: number;
            tax_rate: string;
            cpt_code: string | null;
            insurance_eligible: boolean;
          }>(
            `SELECT
               -- Precedence: an explicitly quoted price, then the payer's
               -- negotiated rate, then catalogue list price.
               COALESCE(
                 $2::integer,
                 (SELECT ppo.allowed_amount_cents
                    FROM payer_price_overrides ppo
                    JOIN patient_insurance_policies pip ON pip.payer_id = ppo.payer_id
                   WHERE ppo.service_item_id = $1 AND pip.id = $3
                     AND ppo.effective_from <= CURRENT_DATE
                     AND (ppo.effective_until IS NULL OR ppo.effective_until >= CURRENT_DATE)
                   ORDER BY ppo.effective_from DESC LIMIT 1),
                 si.unit_price_cents,
                 0
               ) AS unit_price_cents,
               COALESCE(si.tax_rate, 0) AS tax_rate,
               si.cpt_code,
               COALESCE(si.insurance_eligible, true) AS insurance_eligible
             FROM (SELECT 1) AS anchor
             LEFT JOIN service_items si ON si.id = $1`,
            [line.serviceItemId ?? null, line.unitPriceCents ?? null, policy?.id ?? null],
          );

          const price = priced[0];

          await db.query(
            `INSERT INTO invoice_lines (tenant_id, invoice_id, line_no, service_item_id, description,
                                        cpt_code, quantity, unit_price_cents, discount_cents, tax_rate,
                                        diagnosis_codes, is_insurance_eligible, source_kind, source_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              tenantId,
              invoiceId,
              index + 1,
              line.serviceItemId ?? null,
              line.description,
              line.cptCode ?? price?.cpt_code ?? null,
              line.quantity,
              line.unitPriceCents ?? price?.unit_price_cents ?? 0,
              line.discountCents,
              price?.tax_rate ?? 0,
              line.diagnosisCodes,
              price?.insurance_eligible ?? true,
              line.sourceKind,
              line.sourceId ?? null,
            ],
          );
        }

        // Totals are now set by the trigger; read them back rather than
        // recomputing them here, so there is one source of truth.
        const { rows: totals } = await db.query<{
          subtotal_cents: number;
          discount_cents: number;
          tax_cents: number;
          total_cents: number;
          balance_cents: number;
        }>(
          `SELECT subtotal_cents, discount_cents, tax_cents, total_cents, balance_cents
             FROM invoices WHERE id = $1`,
          [invoiceId],
        );

        // Split the bill between payer and patient.
        if (policy) {
          const total = totals[0]!.total_cents;
          const copay = policy.copay_cents ?? 0;
          const coinsurance = policy.coinsurance_rate ? Number(policy.coinsurance_rate) : 0;
          const afterCopay = Math.max(0, total - copay);
          const patientShare = Math.min(total, copay + Math.round(afterCopay * coinsurance));

          await db.query(
            `UPDATE invoices
                SET patient_portion_cents = $2,
                    insurance_portion_cents = $3
              WHERE id = $1`,
            [invoiceId, patientShare, total - patientShare],
          );
        } else {
          await db.query(
            'UPDATE invoices SET patient_portion_cents = total_cents WHERE id = $1',
            [invoiceId],
          );
        }

        collect({
          action: 'invoice.create',
          resourceType: 'invoice',
          resourceId: invoiceId,
          patientId: input.patientId,
          touchedPhi: true,
          metadata: {
            invoiceNumber: created[0]!.invoice_number,
            lineCount: input.lines.length,
            totalCents: totals[0]!.total_cents,
            hasInsurance: Boolean(policy),
          },
        });

        return {
          id: invoiceId,
          invoiceNumber: created[0]!.invoice_number,
          ...totals[0]!,
        };
      });

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  },
);

billingRoutes.get(
  '/invoices',
  requirePermission('invoice:read'),
  validate({ query: invoiceQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = queryParams(req, invoiceQuerySchema);

      const result = await runInTenantReadOnly(req, async ({ db }, collect) => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        const where = (sql: string, value: unknown) => {
          params.push(value);
          conditions.push(sql.replace('$?', `$${params.length}`));
        };

        if (query.patientId) where('i.patient_id = $?', query.patientId);
        if (query.status) where('i.status = $?', query.status);
        if (query.billingStage) where('i.billing_stage = $?', query.billingStage);
        if (query.from) where('i.issued_on >= $?::date', query.from);
        if (query.to) where('i.issued_on <= $?::date', query.to);
        if (query.overdueOnly) {
          conditions.push("i.due_on < CURRENT_DATE AND i.balance_cents > 0 AND i.status <> 'void'");
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const offset = (query.page - 1) * query.pageSize;

        const [{ rows }, { rows: countRows }, { rows: ageing }] = await Promise.all([
          db.query<Record<string, unknown>>(
            `SELECT i.id, i.invoice_number, i.issued_on, i.due_on, i.status, i.billing_stage,
                    i.total_cents, i.amount_paid_cents, i.balance_cents,
                    i.patient_portion_cents, i.insurance_portion_cents,
                    p.full_name AS patient_name, p.mrn,
                    pay.name AS payer_name,
                    GREATEST(0, CURRENT_DATE - i.due_on) AS days_overdue
               FROM invoices i
               JOIN patients p ON p.id = i.patient_id
               LEFT JOIN patient_insurance_policies pip ON pip.id = i.primary_policy_id
               LEFT JOIN insurance_payers pay ON pay.id = pip.payer_id
               ${whereClause}
              ORDER BY i.issued_on DESC, i.invoice_number DESC
              LIMIT ${query.pageSize} OFFSET ${offset}`,
            params,
          ),
          db.query<{ count: string }>(`SELECT count(*) FROM invoices i ${whereClause}`, params),
          // Standard AR ageing buckets, which is how finance reads this.
          db.query<{ bucket: string; total: string; count: string }>(
            `SELECT CASE
                      WHEN due_on >= CURRENT_DATE THEN 'current'
                      WHEN CURRENT_DATE - due_on <= 30 THEN '1-30'
                      WHEN CURRENT_DATE - due_on <= 60 THEN '31-60'
                      WHEN CURRENT_DATE - due_on <= 90 THEN '61-90'
                      ELSE '90+'
                    END AS bucket,
                    sum(balance_cents) AS total,
                    count(*) AS count
               FROM invoices
              WHERE balance_cents > 0 AND status IN ('issued','partially_paid','overdue')
              GROUP BY 1`,
          ),
        ]);

        collect({
          action: 'invoice.list',
          resourceType: 'invoice',
          touchedPhi: true,
          metadata: { resultCount: rows.length },
        });

        return {
          items: rows,
          total: Number(countRows[0]?.count ?? 0),
          ageing: Object.fromEntries(
            ageing.map((a) => [a.bucket, { totalCents: Number(a.total), count: Number(a.count) }]),
          ),
        };
      });

      res.json({
        data: result.items,
        meta: {
          total: result.total,
          page: query.page,
          pageSize: query.pageSize,
          ageing: result.ageing,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Record a payment.
 *
 * The over-allocation guard in the database refuses an allocation larger than
 * the outstanding balance, so a mis-keyed receipt cannot drive the balance
 * negative and report the invoice as paid. That error surfaces here as a 409.
 */
billingRoutes.post(
  '/payments',
  requirePermission('payment:write'),
  validate({ body: recordPaymentSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, recordPaymentSchema);

      const result = await runInTenant(req, async ({ db, tenantId }, collect) => {
        const principal = req.principal!;

        const { rows: invoiceRows } = await db.query<{
          patient_id: string;
          balance_cents: number;
          status: string;
        }>('SELECT patient_id, balance_cents, status FROM invoices WHERE id = $1', [input.invoiceId]);

        const invoice = invoiceRows[0];
        if (!invoice) throw new NotFoundError('invoice');

        if (invoice.status === 'void') {
          throw new AppError(409, 'PRECONDITION_FAILED', 'This invoice has been voided.');
        }
        if (invoice.balance_cents <= 0) {
          throw new AppError(409, 'PRECONDITION_FAILED', 'This invoice is already settled.');
        }

        const { rows: payment } = await db.query<{ id: string; receipt_number: string }>(
          `INSERT INTO payments (tenant_id, receipt_number, patient_id, payer_id, payer_kind,
                                 amount_cents, method, gateway_reference, card_last4,
                                 received_by, notes)
           VALUES ($1, hims_util.allocate_reference($1, 'receipt', 'RCP'), $2, $3, $4,
                   $5, $6, $7, $8, $9, $10)
           RETURNING id, receipt_number`,
          [
            tenantId,
            invoice.patient_id,
            input.payerId ?? null,
            input.payerKind,
            input.amountCents,
            input.method,
            input.gatewayReference ?? null,
            // Only the last four digits, ever. Full card data never enters
            // this system; the gateway holds it and we keep its reference.
            input.cardLast4 ?? null,
            principal.userId,
            input.notes ?? null,
          ],
        );

        await db.query(
          `INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount_cents)
           VALUES ($1, $2, $3, $4)`,
          [tenantId, payment[0]!.id, input.invoiceId, input.amountCents],
        );

        const { rows: updated } = await db.query<{
          balance_cents: number;
          amount_paid_cents: number;
          status: string;
        }>('SELECT balance_cents, amount_paid_cents, status FROM invoices WHERE id = $1', [
          input.invoiceId,
        ]);

        collect({
          action: 'payment.record',
          resourceType: 'payment',
          resourceId: payment[0]!.id,
          patientId: invoice.patient_id,
          touchedPhi: true,
          metadata: {
            receiptNumber: payment[0]!.receipt_number,
            amountCents: input.amountCents,
            method: input.method,
            invoiceId: input.invoiceId,
            remainingBalanceCents: updated[0]!.balance_cents,
          },
        });

        return {
          paymentId: payment[0]!.id,
          receiptNumber: payment[0]!.receipt_number,
          invoiceStatus: updated[0]!.status,
          amountPaidCents: updated[0]!.amount_paid_cents,
          balanceCents: updated[0]!.balance_cents,
        };
      });

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Submit an insurance claim.
 *
 * Builds the claim from the invoice's insurance-eligible lines. The X12 837
 * transmission itself is an integration point: `raw_request` holds the payload
 * the clearinghouse was given, so a denial can be reconciled against exactly
 * what was sent.
 */
billingRoutes.post(
  '/claims',
  requirePermission('claim:write'),
  validate({ body: submitClaimSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, submitClaimSchema);

      const result = await runInTenant(req, async ({ db, tenantId }, collect) => {
        const principal = req.principal!;

        const { rows: invoiceRows } = await db.query<{
          patient_id: string;
          total_cents: number;
          insurance_portion_cents: number;
          status: string;
        }>(
          `SELECT patient_id, total_cents, insurance_portion_cents, status
             FROM invoices WHERE id = $1`,
          [input.invoiceId],
        );

        const invoice = invoiceRows[0];
        if (!invoice) throw new NotFoundError('invoice');
        if (invoice.status === 'void') {
          throw new AppError(409, 'PRECONDITION_FAILED', 'Cannot claim against a voided invoice.');
        }

        const { rows: policyRows } = await db.query<{
          payer_id: string;
          verification_status: string;
          expires_on: Date | null;
        }>(
          `SELECT payer_id, verification_status, expires_on
             FROM patient_insurance_policies
            WHERE id = $1 AND patient_id = $2 AND is_active`,
          [input.policyId, invoice.patient_id],
        );

        const policy = policyRows[0];
        if (!policy) throw new NotFoundError('insurance policy');

        if (policy.expires_on && policy.expires_on < new Date()) {
          throw new AppError(
            422,
            'VALIDATION_FAILED',
            'That policy has expired. Verify current coverage before claiming.',
          );
        }
        // Submitting against unverified coverage is the main cause of
        // avoidable denials, so it is blocked rather than warned about.
        if (policy.verification_status !== 'active') {
          throw new AppError(
            422,
            'VALIDATION_FAILED',
            'Run an eligibility check on this policy before submitting the claim.',
          );
        }

        const { rows: eligibleLines } = await db.query<{
          id: string;
          cpt_code: string | null;
          quantity: string;
          net_cents: number;
          diagnosis_codes: string[];
        }>(
          `SELECT id, cpt_code, quantity, net_cents, diagnosis_codes
             FROM invoice_lines
            WHERE invoice_id = $1 AND is_insurance_eligible
            ORDER BY line_no`,
          [input.invoiceId],
        );

        if (eligibleLines.length === 0) {
          throw new AppError(
            422,
            'VALIDATION_FAILED',
            'No lines on this invoice are eligible for insurance.',
          );
        }

        const missingCpt = eligibleLines.filter((l) => !l.cpt_code);
        if (missingCpt.length > 0) {
          throw new AppError(
            422,
            'VALIDATION_FAILED',
            `${missingCpt.length} line(s) have no procedure code. A claim without CPT codes will be rejected.`,
          );
        }

        const claimedCents = eligibleLines.reduce((sum, l) => sum + l.net_cents, 0);

        const { rows: claim } = await db.query<{ id: string; claim_number: string }>(
          `INSERT INTO insurance_claims (tenant_id, claim_number, invoice_id, patient_id, policy_id,
                                         payer_id, claimed_cents, status, submission_format,
                                         prior_auth_number, submitted_by,
                                         appeal_deadline)
           VALUES ($1, hims_util.allocate_reference($1, 'claim', 'CLM'), $2, $3, $4,
                   $5, $6, 'ready', $7, $8, $9,
                   CURRENT_DATE + 180)
           RETURNING id, claim_number`,
          [
            tenantId,
            input.invoiceId,
            invoice.patient_id,
            input.policyId,
            policy.payer_id,
            claimedCents,
            input.submissionFormat,
            input.priorAuthNumber ?? null,
            principal.userId,
          ],
        );

        for (const [index, line] of eligibleLines.entries()) {
          await db.query(
            `INSERT INTO claim_lines (tenant_id, claim_id, invoice_line_id, line_no, cpt_code,
                                      diagnosis_pointers, units, charged_cents, service_date)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE)`,
            [
              tenantId,
              claim[0]!.id,
              line.id,
              index + 1,
              line.cpt_code,
              line.diagnosis_codes,
              line.quantity,
              line.net_cents,
            ],
          );
        }

        await db.query(`UPDATE invoices SET billing_stage = 'with_insurer' WHERE id = $1`, [
          input.invoiceId,
        ]);

        collect({
          action: 'claim.submit',
          resourceType: 'insurance_claim',
          resourceId: claim[0]!.id,
          patientId: invoice.patient_id,
          touchedPhi: true,
          metadata: {
            claimNumber: claim[0]!.claim_number,
            claimedCents,
            lineCount: eligibleLines.length,
            payerId: policy.payer_id,
          },
        });

        return {
          id: claim[0]!.id,
          claimNumber: claim[0]!.claim_number,
          claimedCents,
          lineCount: eligibleLines.length,
          status: 'ready',
        };
      });

      res.status(201).json({
        data: result,
        meta: {
          notice:
            'The claim is built and queued. Transmission to the clearinghouse is handled by the claims worker.',
        },
      });
    } catch (error) {
      next(error);
    }
  },
);
