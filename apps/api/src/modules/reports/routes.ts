/**
 * Reporting.
 *
 * Every query here runs in a READ ONLY transaction, so a report can never
 * mutate a chart however it is written. Clinical reports are permissioned
 * separately from financial ones: a billing officer has no business in a
 * diagnosis-mix report, and a clinician has none in payer margins.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireStaffAccount } from '../../middleware/authorize.js';
import { param, queryParams, validate } from '../../middleware/validate.js';
import { runInTenantReadOnly } from '../../middleware/tenant.js';
import { exportLimiter } from '../../middleware/rate-limit.js';

export const reportRoutes = Router();
reportRoutes.use(authenticate, requireStaffAccount());

const dateRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  facilityId: z.string().uuid().optional(),
});

/**
 * Operational dashboard.
 *
 * One round trip rather than six: the landing page of a hospital system is
 * loaded by every member of staff at the start of every shift, so it is worth
 * assembling in a single query.
 */
reportRoutes.get(
  '/dashboard',
  requirePermission('report:operational', 'report:clinical', 'report:financial'),
  validate({ query: dateRangeSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = queryParams(req, dateRangeSchema);

      const data = await runInTenantReadOnly(req, async ({ db }) => {
        const principal = req.principal!;
        const canSeeMoney = principal.permissions.has('report:financial');

        const { rows } = await db.query<Record<string, unknown>>(
          `
          SELECT
            -- Today's clinic
            (SELECT count(*) FROM appointments
              WHERE starts_at::date = CURRENT_DATE
                AND status NOT IN ('cancelled','no_show')
                AND ($1::uuid IS NULL OR facility_id = $1)) AS appointments_today,
            (SELECT count(*) FROM appointments
              WHERE starts_at::date = CURRENT_DATE AND status = 'checked_in'
                AND ($1::uuid IS NULL OR facility_id = $1)) AS waiting_now,
            (SELECT count(*) FROM appointments
              WHERE starts_at::date = CURRENT_DATE AND status = 'in_progress'
                AND ($1::uuid IS NULL OR facility_id = $1)) AS in_consultation,
            -- Median wait, which is the number patients actually experience;
            -- a mean is dragged around by one four-hour outlier.
            (SELECT percentile_cont(0.5) WITHIN GROUP (
                      ORDER BY EXTRACT(EPOCH FROM (started_at - checked_in_at)) / 60)
               FROM appointments
              WHERE starts_at::date = CURRENT_DATE
                AND checked_in_at IS NOT NULL AND started_at IS NOT NULL) AS median_wait_minutes,
            -- Roster
            (SELECT count(*) FROM patients
              WHERE status = 'active' AND deleted_at IS NULL) AS active_patients,
            (SELECT count(*) FROM patients
              WHERE created_at >= CURRENT_DATE - 30 AND deleted_at IS NULL) AS new_patients_30d,
            -- Clinical backlog: unsigned notes are a compliance and billing risk
            (SELECT count(*) FROM encounters
              WHERE status IN ('draft','in_progress','pending_signature')
                AND started_at < now() - interval '24 hours') AS unsigned_notes_overdue,
            (SELECT count(*) FROM diagnostic_results
              WHERE is_critical AND acknowledged_at IS NULL) AS critical_results_unacknowledged,
            (SELECT count(*) FROM prescriptions
              WHERE status IN ('active','partially_dispensed')) AS prescriptions_pending,
            -- Inventory
            (SELECT count(*) FROM v_stock_status
              WHERE stock_state IN ('low','critical','out_of_stock')) AS stock_alerts_open,
            (SELECT count(*) FROM stock_batches
              WHERE status = 'available' AND quantity_on_hand > 0
                AND expires_on IS NOT NULL AND expires_on <= CURRENT_DATE + 30) AS batches_expiring_30d,
            -- Money, only when the caller may see it
            CASE WHEN $2 THEN (SELECT COALESCE(sum(balance_cents), 0) FROM invoices
                                WHERE status IN ('issued','partially_paid','overdue')) END
              AS outstanding_balance_cents,
            CASE WHEN $2 THEN (SELECT COALESCE(sum(amount_cents), 0) FROM payments
                                WHERE received_at::date = CURRENT_DATE AND status = 'settled') END
              AS collected_today_cents,
            CASE WHEN $2 THEN (SELECT count(*) FROM insurance_claims
                                WHERE status IN ('submitted','acknowledged','in_review')) END
              AS claims_in_flight,
            CASE WHEN $2 THEN (SELECT count(*) FROM insurance_claims
                                WHERE status = 'denied'
                                  AND adjudicated_at >= CURRENT_DATE - 30) END
              AS claims_denied_30d,
            -- Compliance
            (SELECT count(*) FROM break_glass_grants
              WHERE reviewed_at IS NULL) AS break_glass_pending_review,
            (SELECT count(*) FROM staff_profiles
              WHERE is_active AND license_expires_on IS NOT NULL
                AND license_expires_on <= CURRENT_DATE + 60) AS licences_expiring_soon
          `,
          [query.facilityId ?? null, canSeeMoney],
        );

        return rows[0]!;
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

/** Appointment throughput: volume, no-show rate and utilisation by provider. */
reportRoutes.get(
  '/utilisation',
  requirePermission('report:operational'),
  validate({ query: dateRangeSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = queryParams(req, dateRangeSchema);

      const data = await runInTenantReadOnly(req, async ({ db }) => {
        const { rows } = await db.query<Record<string, unknown>>(
          `
          SELECT sp.id AS provider_id, sp.display_name, d.name AS department,
                 count(*) AS booked,
                 count(*) FILTER (WHERE a.status = 'completed') AS completed,
                 count(*) FILTER (WHERE a.status = 'no_show') AS no_shows,
                 count(*) FILTER (WHERE a.status = 'cancelled') AS cancelled,
                 round(
                   100.0 * count(*) FILTER (WHERE a.status = 'no_show')
                   / NULLIF(count(*) FILTER (WHERE a.status NOT IN ('cancelled')), 0),
                   1
                 ) AS no_show_rate_pct,
                 round(
                   avg(EXTRACT(EPOCH FROM (a.ends_at - a.starts_at)) / 60)
                   FILTER (WHERE a.status = 'completed'), 1
                 ) AS avg_slot_minutes,
                 round(
                   avg(EXTRACT(EPOCH FROM (a.completed_at - a.started_at)) / 60)
                   FILTER (WHERE a.completed_at IS NOT NULL AND a.started_at IS NOT NULL), 1
                 ) AS avg_actual_minutes
            FROM appointments a
            JOIN staff_profiles sp ON sp.id = a.provider_id
            LEFT JOIN departments d ON d.id = a.department_id
           WHERE a.starts_at >= COALESCE($1::date, CURRENT_DATE - 30)
             AND a.starts_at < COALESCE($2::date, CURRENT_DATE) + 1
             AND ($3::uuid IS NULL OR a.facility_id = $3)
           GROUP BY sp.id, sp.display_name, d.name
           ORDER BY booked DESC
           LIMIT 200
          `,
          [query.from ?? null, query.to ?? null, query.facilityId ?? null],
        );

        return rows;
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

/** Revenue, payer mix and denial reasons. */
reportRoutes.get(
  '/revenue',
  requirePermission('report:financial'),
  validate({ query: dateRangeSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = queryParams(req, dateRangeSchema);

      const data = await runInTenantReadOnly(req, async ({ db }) => {
        const [byPayer, byCategory, denials, collections] = await Promise.all([
          db.query<Record<string, unknown>>(
            `SELECT COALESCE(pay.name, 'Self-pay') AS payer,
                    count(DISTINCT i.id) AS invoices,
                    sum(i.total_cents) AS billed_cents,
                    sum(i.amount_paid_cents) AS collected_cents,
                    sum(i.balance_cents) AS outstanding_cents,
                    round(100.0 * sum(i.amount_paid_cents) / NULLIF(sum(i.total_cents), 0), 1)
                      AS collection_rate_pct
               FROM invoices i
               LEFT JOIN patient_insurance_policies pip ON pip.id = i.primary_policy_id
               LEFT JOIN insurance_payers pay ON pay.id = pip.payer_id
              WHERE i.issued_on >= COALESCE($1::date, CURRENT_DATE - 30)
                AND i.issued_on <= COALESCE($2::date, CURRENT_DATE)
                AND i.status <> 'void'
              GROUP BY 1 ORDER BY billed_cents DESC NULLS LAST`,
            [query.from ?? null, query.to ?? null],
          ),
          db.query<Record<string, unknown>>(
            `SELECT si.category,
                    sum(il.net_cents) AS net_cents,
                    sum(il.quantity) AS units
               FROM invoice_lines il
               JOIN invoices i ON i.id = il.invoice_id
               LEFT JOIN service_items si ON si.id = il.service_item_id
              WHERE i.issued_on >= COALESCE($1::date, CURRENT_DATE - 30)
                AND i.issued_on <= COALESCE($2::date, CURRENT_DATE)
                AND i.status <> 'void'
              GROUP BY 1 ORDER BY net_cents DESC NULLS LAST`,
            [query.from ?? null, query.to ?? null],
          ),
          // Denial reasons, trended. This is where recoverable revenue hides.
          db.query<Record<string, unknown>>(
            `SELECT code.value ->> 'code' AS denial_code,
                    code.value ->> 'description' AS description,
                    count(*) AS occurrences,
                    sum(c.denied_cents) AS denied_cents
               FROM insurance_claims c
               CROSS JOIN LATERAL jsonb_array_elements(c.denial_codes) AS code(value)
              WHERE c.adjudicated_at >= COALESCE($1::date, CURRENT_DATE - 90)
              GROUP BY 1, 2 ORDER BY denied_cents DESC NULLS LAST LIMIT 20`,
            [query.from ?? null],
          ),
          db.query<Record<string, unknown>>(
            `SELECT method, count(*) AS payments, sum(amount_cents) AS total_cents
               FROM payments
              WHERE received_at >= COALESCE($1::date, CURRENT_DATE - 30)
                AND status = 'settled'
              GROUP BY 1 ORDER BY total_cents DESC`,
            [query.from ?? null],
          ),
        ]);

        return {
          byPayer: byPayer.rows,
          byServiceCategory: byCategory.rows,
          topDenialReasons: denials.rows,
          collectionsByMethod: collections.rows,
        };
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Accounting of disclosures (HIPAA §164.528).
 *
 * A patient is entitled to a list of who accessed their record. The audit
 * table's `patient_id` column exists precisely so this is one indexed query
 * rather than a union across twenty tables.
 */
reportRoutes.get(
  '/patient-access-log/:patientId',
  exportLimiter,
  requirePermission('audit:read'),
  validate({
    params: z.object({ patientId: z.string().uuid() }),
    query: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = param(req, 'patientId');

      const data = await runInTenantReadOnly(req, async ({ db }, collect) => {
        const { rows } = await db.query<Record<string, unknown>>(
          `SELECT a.occurred_at, a.action, a.actor_label, a.actor_role, a.outcome,
                  a.resource_type, a.metadata ->> 'accessBasis' AS access_basis,
                  a.ip_address
             FROM audit_events a
            WHERE a.patient_id = $1
              AND a.touched_phi
              AND a.occurred_at >= COALESCE($2::date, CURRENT_DATE - interval '6 years')
              AND a.occurred_at <= COALESCE($3::date, CURRENT_DATE) + 1
            ORDER BY a.occurred_at DESC
            LIMIT 5000`,
          [patientId, req.query.from ?? null, req.query.to ?? null],
        );

        // Running the report is itself a PHI access, and is logged as one.
        collect({
          action: 'audit.disclosure_report',
          resourceType: 'audit_events',
          patientId,
          touchedPhi: true,
          metadata: { recordCount: rows.length },
        });

        return rows;
      });

      res.json({ data, meta: { count: data.length } });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Break-glass review queue.
 *
 * Emergency access is only acceptable because it is reviewed afterwards. An
 * unreviewed queue is the finding an auditor opens with.
 */
reportRoutes.get(
  '/break-glass-review',
  requirePermission('audit:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await runInTenantReadOnly(req, async ({ db }) => {
        const { rows } = await db.query<Record<string, unknown>>(
          `SELECT g.id, g.created_at, g.expires_at, g.justification,
                  u.full_name AS accessed_by, u.email,
                  p.full_name AS patient_name, p.mrn,
                  g.reviewed_at, g.review_outcome,
                  -- What they actually did with the access, which is the
                  -- question the review has to answer.
                  (SELECT count(*) FROM audit_events a
                    WHERE a.actor_user_id = g.user_id
                      AND a.patient_id = g.patient_id
                      AND a.occurred_at BETWEEN g.created_at AND g.expires_at) AS actions_taken
             FROM break_glass_grants g
             JOIN users u ON u.id = g.user_id
             JOIN patients p ON p.id = g.patient_id
            WHERE g.reviewed_at IS NULL
            ORDER BY g.created_at
            LIMIT 200`,
        );

        return rows;
      });

      res.json({ data, meta: { pendingReview: data.length } });
    } catch (error) {
      next(error);
    }
  },
);
