/**
 * Subscription billing: what the hospital owes the vendor.
 *
 * Not to be confused with `modules/billing`, which is what a patient owes a
 * hospital. Different ledgers, different companies' money, deliberately no
 * shared code — the one thing worse than duplicating an invoice table is
 * accidentally sharing one.
 *
 * The model is as small as it can honestly be: a flat fee per tier, an
 * override for a negotiated contract, an invoice per period, and payments an
 * operator records because the money moved somewhere else. No metering, no
 * payment provider, no dunning automation. Each of those can be added on top
 * of this ledger; none of them can be added underneath it.
 */
import type { Queryable } from '../../db/pool.js';
import { withoutTenantIsolation } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';
import type { PlatformPrincipal } from '../../middleware/authenticate-platform.js';
import { recordPlatformAction, type RequestMeta } from './service.js';
import { CUSTOMER_INVOICE_PAYMENTS_SQL } from './invoice-pdf.js';
import { invoiceDownloadUrl } from '../../security/download-tokens.js';
import { logger } from '../../utils/logger.js';

/* ---------------------------------------------------------------------------
 * The price book
 * ------------------------------------------------------------------------- */

export async function listPlans(): Promise<Record<string, unknown>[]> {
  return withoutTenantIsolation('platform console: reading the price book', async (db) => {
    const { rows } = await db.query(
      `SELECT id, tier, currency, amount_cents, billing_interval, payment_terms_days,
              description, is_active, updated_at
         FROM subscription_plans
        ORDER BY currency, CASE tier WHEN 'trial' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END`,
    );
    return rows;
  });
}

export interface PlanInput {
  amountCents: number;
  paymentTermsDays?: number;
  description?: string | null;
  isActive?: boolean;
}

export async function updatePlan(
  planId: string,
  input: PlanInput,
  operator: PlatformPrincipal,
  meta: RequestMeta,
): Promise<Record<string, unknown>> {
  return withoutTenantIsolation('platform console: changing the price book', async (db) => {
    const { rows: existing } = await db.query<{
      tier: string;
      currency: string;
      amount_cents: string;
    }>('SELECT tier, currency, amount_cents FROM subscription_plans WHERE id = $1 FOR UPDATE', [
      planId,
    ]);

    const plan = existing[0];
    if (!plan) throw new AppError(404, 'NOT_FOUND', 'That plan could not be found.');

    if (plan.tier === 'trial' && input.amountCents !== 0) {
      throw new AppError(422, 'VALIDATION_FAILED', 'The trial tier has to stay free.', {
        issues: [
          {
            field: 'amountCents',
            message:
              'A priced trial would invoice hospitals nobody has agreed terms with yet. Move them to standard instead.',
          },
        ],
      });
    }

    const { rows } = await db.query(
      `UPDATE subscription_plans
          SET amount_cents = $2,
              payment_terms_days = COALESCE($3, payment_terms_days),
              description = COALESCE($4, description),
              is_active = COALESCE($5, is_active)
        WHERE id = $1
       RETURNING id, tier, currency, amount_cents, billing_interval, payment_terms_days,
                 description, is_active, updated_at`,
      [
        planId,
        input.amountCents,
        input.paymentTermsDays ?? null,
        input.description ?? null,
        input.isActive ?? null,
      ],
    );

    // Changing the book never restates an issued invoice — those carry their
    // own amount — so this is recorded as a forward-looking price change.
    await recordPlatformAction(
      db,
      operator,
      {
        action: 'platform.plan_price_changed',
        resourceType: 'subscription_plan',
        resourceId: planId,
        changes: {
          amount_cents: { from: Number(plan.amount_cents), to: input.amountCents },
        },
        metadata: { tier: plan.tier, currency: plan.currency },
      },
      meta,
    );

    return rows[0]!;
  });
}

/* ---------------------------------------------------------------------------
 * One hospital's terms
 * ------------------------------------------------------------------------- */

/** The effective price: the negotiated override, else the price book. */
const EFFECTIVE_AMOUNT_SQL = `
  COALESCE(
    s.amount_cents,
    (SELECT p.amount_cents FROM subscription_plans p
      WHERE p.tier = t.subscription_tier
        AND p.currency = s.currency
        AND p.billing_interval = s.billing_interval
        AND p.is_active)
  )`;

/**
 * Read a subscription on a CALLER-SUPPLIED connection.
 *
 * The split matters. A writer that finishes by calling the public
 * `getSubscription` below would open a SECOND transaction to read back what
 * it had just written but not yet committed — and get the state from before
 * its own change. Every mutation here returns the row it just wrote, so
 * every mutation reads it through this, inside its own transaction.
 */
async function loadSubscription(
  db: Queryable,
  tenantId: string,
): Promise<Record<string, unknown> | null> {
  {
    const { rows } = await db.query(
      `SELECT s.tenant_id, s.currency, s.billing_interval, s.amount_cents AS override_cents,
              s.payment_terms_days AS override_terms_days,
              s.current_period_start, s.current_period_end, s.trial_ends_on,
              s.status, s.cancelled_on, s.notes,
              t.subscription_tier AS tier,
              ${EFFECTIVE_AMOUNT_SQL} AS effective_amount_cents,
              (s.amount_cents IS NOT NULL) AS has_negotiated_rate,
              (SELECT count(*) FROM subscription_invoices i
                WHERE i.tenant_id = s.tenant_id AND i.status <> 'void') AS invoice_count,
              (SELECT COALESCE(sum(i.total_cents - i.amount_paid_cents), 0)
                 FROM subscription_invoices i
                WHERE i.tenant_id = s.tenant_id
                  AND i.status IN ('issued','partially_paid')) AS outstanding_cents,
              (SELECT COALESCE(sum(i.total_cents - i.amount_paid_cents), 0)
                 FROM subscription_invoices i
                WHERE i.tenant_id = s.tenant_id
                  AND i.status IN ('issued','partially_paid')
                  AND i.due_on < CURRENT_DATE) AS overdue_cents
         FROM tenant_subscriptions s
         JOIN tenants t ON t.id = s.tenant_id
        WHERE s.tenant_id = $1`,
      [tenantId],
    );

    return rows[0] ?? null;
  }
}

export async function getSubscription(tenantId: string): Promise<Record<string, unknown> | null> {
  return withoutTenantIsolation('platform console: reading a subscription', (db) =>
    loadSubscription(db, tenantId),
  );
}

export interface SubscriptionInput {
  currency?: string;
  billingInterval?: 'month' | 'year';
  /** null clears a negotiated rate and returns the hospital to the price book. */
  amountCents?: number | null;
  paymentTermsDays?: number | null;
  trialEndsOn?: string | null;
  status?: 'trialing' | 'active' | 'cancelled';
  notes?: string | null;
}

/**
 * Create or amend a hospital's terms.
 *
 * Upsert rather than create-then-update: a hospital provisioned before this
 * existed has no row, and the first person to open its billing panel should
 * not have to know that.
 */
export async function setSubscription(
  tenantId: string,
  input: SubscriptionInput,
  operator: PlatformPrincipal,
  meta: RequestMeta,
): Promise<Record<string, unknown>> {
  return withoutTenantIsolation('platform console: setting subscription terms', async (db) => {
    const { rows: tenantRows } = await db.query<{ currency: string; subscription_tier: string }>(
      'SELECT currency, subscription_tier FROM tenants WHERE id = $1',
      [tenantId],
    );

    const tenant = tenantRows[0];
    if (!tenant) throw new AppError(404, 'NOT_FOUND', 'That hospital could not be found.');

    const { rows: before } = await db.query<Record<string, unknown>>(
      'SELECT * FROM tenant_subscriptions WHERE tenant_id = $1 FOR UPDATE',
      [tenantId],
    );

    const interval = input.billingInterval ?? (before[0]?.billing_interval as string) ?? 'month';

    if (before.length === 0) {
      // The vendor's billing currency defaults to the hospital's own, which is
      // right far more often than not, and is overridable in the same call.
      await db.query(
        `INSERT INTO tenant_subscriptions
           (tenant_id, currency, billing_interval, amount_cents, payment_terms_days,
            current_period_start, current_period_end, trial_ends_on, status, notes)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE,
                 CURRENT_DATE + CASE WHEN $3 = 'year' THEN interval '1 year' ELSE interval '1 month' END,
                 $6, $7, $8)`,
        [
          tenantId,
          input.currency ?? tenant.currency,
          interval,
          input.amountCents ?? null,
          input.paymentTermsDays ?? null,
          input.trialEndsOn ?? null,
          input.status ?? (tenant.subscription_tier === 'trial' ? 'trialing' : 'active'),
          input.notes ?? null,
        ],
      );
    } else {
      const assignments: string[] = [];
      const params: unknown[] = [tenantId];

      const set = (column: string, value: unknown) => {
        params.push(value);
        assignments.push(`${column} = $${params.length}`);
      };

      if (input.currency !== undefined) set('currency', input.currency);
      if (input.billingInterval !== undefined) set('billing_interval', input.billingInterval);
      // `null` here is meaningful: it CLEARS a negotiated rate.
      if (input.amountCents !== undefined) set('amount_cents', input.amountCents);
      if (input.paymentTermsDays !== undefined) set('payment_terms_days', input.paymentTermsDays);
      if (input.trialEndsOn !== undefined) set('trial_ends_on', input.trialEndsOn);
      if (input.notes !== undefined) set('notes', input.notes);
      if (input.status !== undefined) {
        set('status', input.status);
        set('cancelled_on', input.status === 'cancelled' ? new Date() : null);
      }

      if (assignments.length > 0) {
        await db.query(
          `UPDATE tenant_subscriptions SET ${assignments.join(', ')} WHERE tenant_id = $1`,
          params,
        );
      }
    }

    await recordPlatformAction(
      db,
      operator,
      {
        action: 'platform.subscription_updated',
        resourceType: 'tenant_subscription',
        resourceId: tenantId,
        tenantId,
        changes: { fields: Object.keys(input) },
        metadata: { negotiatedRate: input.amountCents ?? undefined },
      },
      meta,
    );

    return (await loadSubscription(db, tenantId))!;
  });
}

/* ---------------------------------------------------------------------------
 * Issuing
 * ------------------------------------------------------------------------- */

export interface DueSubscription {
  tenant_id: string;
  display_name: string;
  slug: string;
  tier: string;
  currency: string;
  billing_interval: string;
  amount_cents: string | null;
  payment_terms_days: number | null;
  current_period_end: string;
  /** Whole billing periods elapsed since this hospital was last paid up. */
  periods_due: number;
}

/**
 * The most periods one run will invoice for a single hospital.
 *
 * A guard against bad data rather than a business rule: a subscription whose
 * period end was mistyped as 1970 should produce a loud "needs attention",
 * not six hundred invoices.
 */
const MAX_CATCHUP_PERIODS = 24;

/**
 * Hospitals whose paid-up period has run out.
 *
 * Deliberately excludes trials and anything priced at zero: issuing a
 * nil invoice tells the customer nothing and gives the vendor a ledger full
 * of noise to scroll past.
 */
async function findDue(db: Queryable): Promise<DueSubscription[]> {
  const { rows } = await db.query<DueSubscription>(
    `SELECT s.tenant_id, t.display_name, t.slug, t.subscription_tier AS tier,
            s.currency, s.billing_interval,
            ${EFFECTIVE_AMOUNT_SQL} AS amount_cents,
            COALESCE(s.payment_terms_days,
                     (SELECT p.payment_terms_days FROM subscription_plans p
                       WHERE p.tier = t.subscription_tier AND p.currency = s.currency
                         AND p.billing_interval = s.billing_interval AND p.is_active),
                     30) AS payment_terms_days,
            s.current_period_end,
            -- How many whole periods have elapsed since the hospital was last
            -- paid up, rounded up, minimum one. Usually 1; more when an
            -- account has been missed. Capped so a nonsense date cannot ask
            -- for a thousand invoices.
            --
            -- Counted from age(), which returns an interval of years,
            -- months and days. Dividing an epoch by one month would be wrong
            -- here: Postgres treats a month as 30 days for that purpose, so
            -- a 31-day February-to-March gap would round up to two periods.
            LEAST($1::int, GREATEST(1,
              CASE WHEN s.billing_interval = 'year' THEN
                (date_part('year', age(CURRENT_DATE, s.current_period_end))
                 + CASE WHEN date_part('month', age(CURRENT_DATE, s.current_period_end)) > 0
                          OR date_part('day', age(CURRENT_DATE, s.current_period_end)) > 0
                        THEN 1 ELSE 0 END)::int
              ELSE
                (date_part('year', age(CURRENT_DATE, s.current_period_end)) * 12
                 + date_part('month', age(CURRENT_DATE, s.current_period_end))
                 + CASE WHEN date_part('day', age(CURRENT_DATE, s.current_period_end)) > 0
                        THEN 1 ELSE 0 END)::int
              END
            )) AS periods_due
       FROM tenant_subscriptions s
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.status = 'active'
        AND s.current_period_end <= CURRENT_DATE
        AND (s.trial_ends_on IS NULL OR s.trial_ends_on <= CURRENT_DATE)
        -- An archived hospital is not billed; a suspended one still is,
        -- because suspension is usually FOR non-payment and cancelling the
        -- debt on suspending it would be the wrong way round.
        AND t.status <> 'archived'
      ORDER BY t.display_name`,
    [MAX_CATCHUP_PERIODS],
  );

  return rows.filter((row) => row.amount_cents !== null && Number(row.amount_cents) > 0);
}

export async function previewDue(): Promise<DueSubscription[]> {
  return withoutTenantIsolation('platform console: previewing the billing run', (db) => findDue(db));
}

export interface IssueResult {
  issued: Array<{
    tenantName: string;
    invoiceNumber: string;
    totalCents: number;
    currency: string;
    /** How many hospital administrators the invoice was sent to. */
    notified: number;
  }>;
  skipped: Array<{ tenantName: string; reason: string }>;
}

/**
 * Issue every invoice that is due, in one transaction.
 *
 * THE RUN CATCHES UP COMPLETELY, and that is the whole point of the inner
 * loop. A first attempt issued one period per hospital per run, which looked
 * fine on a hospital a month behind and was wrong on one three months behind:
 * it owed three invoices, got one, and the run left it still due. Pressing
 * the button twice produced different results, and an operator had no way to
 * know how many times to press it. Now a run leaves nothing due, so pressing
 * it again is genuinely a no-op — which is the only behaviour anyone can
 * reason about.
 *
 * Idempotent twice over: the query only finds subscriptions whose period has
 * ended, and issuing advances that period past today. The unique index on
 * (tenant_id, period_start, period_end) is the backstop if two operators
 * press the button at the same moment — the second transaction fails rather
 * than double-billing a hospital, which is the right way for that race to
 * end.
 */
export async function issueDueInvoices(
  operator: PlatformPrincipal,
  meta: RequestMeta,
): Promise<IssueResult> {
  return withoutTenantIsolation('platform console: issuing subscription invoices', async (db) => {
    const due = await findDue(db);
    const issued: IssueResult['issued'] = [];
    const skipped: IssueResult['skipped'] = [];

    for (const row of due) {
      const amount = Number(row.amount_cents);

      // Belt and braces: findDue already filters these out, but a priced
      // tier with no matching row in the book would otherwise bill zero.
      if (!Number.isFinite(amount) || amount <= 0) {
        skipped.push({
          tenantName: row.display_name,
          reason: `No active price for the ${row.tier} tier in ${row.currency}.`,
        });
        continue;
      }

      // One invoice per elapsed period, oldest first, so an account in
      // arrears ends the run owing the right number of invoices with the
      // right periods on them.
      let cursor = row.current_period_end;

      for (let period = 0; period < row.periods_due; period += 1) {
        const { rows: numbered } = await db.query<{ number: string }>(
          'SELECT hims_util.next_subscription_invoice_number() AS number',
        );

        const { rows: invoiceRows } = await db.query<{
          id: string;
          invoice_number: string;
          total_cents: string;
          period_start: string;
          period_end: string;
          due_on: string;
        }>(
          `INSERT INTO subscription_invoices
             (tenant_id, invoice_number, tier, period_start, period_end, currency,
              amount_cents, issued_on, due_on, issued_by)
           VALUES ($1, $2, $3, $4::date,
                   $4::date + CASE WHEN $5 = 'year' THEN interval '1 year' ELSE interval '1 month' END,
                   $6, $7, CURRENT_DATE, CURRENT_DATE + make_interval(days => $8), $9)
           RETURNING id, invoice_number, total_cents, period_start, period_end, due_on`,
          [
            row.tenant_id,
            numbered[0]!.number,
            row.tier,
            cursor,
            row.billing_interval,
            row.currency,
            amount,
            row.payment_terms_days ?? 30,
            operator.operatorId,
          ],
        );

        const invoice = invoiceRows[0]!;
        cursor = invoice.period_end;

        await recordPlatformAction(
          db,
          operator,
          {
            action: 'platform.invoice_issued',
            resourceType: 'subscription_invoice',
            resourceId: invoice.id,
            tenantId: row.tenant_id,
            metadata: {
              invoiceNumber: invoice.invoice_number,
              totalCents: Number(invoice.total_cents),
              currency: row.currency,
              period: `${invoice.period_start} to ${invoice.period_end}`,
              catchUp: row.periods_due > 1 ? `${period + 1} of ${row.periods_due}` : undefined,
            },
          },
          meta,
        );

        // Queued inside the same transaction as the invoice: both or
        // neither. An invoice nobody is told about is not delivered.
        const notified = await notifyInvoiceIssued(db, {
          id: invoice.id,
          tenant_id: row.tenant_id,
          invoice_number: invoice.invoice_number,
          tier: row.tier,
          currency: row.currency,
          total_cents: Number(invoice.total_cents),
          period_start: invoice.period_start,
          period_end: invoice.period_end,
          due_on: invoice.due_on,
          tenant_name: row.display_name,
        });

        if (notified === 0) {
          skipped.push({
            tenantName: row.display_name,
            reason: `${invoice.invoice_number} was issued, but this hospital has no active administrator to send it to. Send it on by hand.`,
          });
        }

        issued.push({
          tenantName: row.display_name,
          invoiceNumber: invoice.invoice_number,
          totalCents: Number(invoice.total_cents),
          currency: row.currency,
          notified,
        });
      }

      // Advanced once, to where the catch-up finished.
      await db.query(
        `UPDATE tenant_subscriptions
            SET current_period_start = $2::date -
                  CASE WHEN billing_interval = 'year' THEN interval '1 year' ELSE interval '1 month' END,
                current_period_end = $2::date
          WHERE tenant_id = $1`,
        [row.tenant_id, cursor],
      );

      // A subscription that hit the cap is still behind after the run, so it
      // is reported rather than quietly left for the next one.
      if (row.periods_due >= MAX_CATCHUP_PERIODS) {
        skipped.push({
          tenantName: row.display_name,
          reason: `Billed ${MAX_CATCHUP_PERIODS} periods, the per-run limit, and is still in arrears. Check the subscription dates.`,
        });
      }
    }

    return { issued, skipped };
  });
}

/* ---------------------------------------------------------------------------
 * Telling the hospital
 * ------------------------------------------------------------------------- */

/** Currencies whose smallest unit is the unit. Mirrors the PDF renderer. */
const ZERO_DECIMAL = new Set(['TZS', 'UGX', 'RWF', 'BIF', 'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XOF', 'XAF']);

function formatAmount(minorUnits: number, currency: string): string {
  const digits = ZERO_DECIMAL.has(currency) ? 0 : 2;
  const value = minorUnits / (digits === 0 ? 1 : 100);

  return `${currency} ${value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function formatDay(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Queue an in-app and an email notification for every hospital administrator.
 *
 * ADDRESSED BY PERMISSION, not by role. `tenant:settings` is what gates the
 * hospital's own configuration screen, so it is already the answer to "who
 * here deals with the vendor" — and a hospital that invents a custom role
 * holding it gets the invoice without anyone remembering to update a list of
 * role names here.
 *
 * Queued in the SAME TRANSACTION as the invoice. An invoice that exists with
 * nothing queued is one the hospital never hears about; a notification
 * queued for an invoice that rolled back is worse. Both or neither.
 *
 * A failure to find any recipient is logged loudly rather than thrown: the
 * invoice is still a valid debt, and refusing to bill a hospital because its
 * last administrator was deactivated would be the wrong way round. It
 * surfaces in the run result instead.
 */
async function notifyInvoiceIssued(
  db: Queryable,
  invoice: {
    id: string;
    tenant_id: string;
    invoice_number: string;
    tier: string;
    currency: string;
    total_cents: number;
    period_start: string;
    period_end: string;
    due_on: string;
    tenant_name: string;
  },
): Promise<number> {
  const { rows: admins } = await db.query<{ id: string }>(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE u.tenant_id = $1
        AND u.status = 'active'
        AND rp.permission_key = 'tenant:settings'
        AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
    [invoice.tenant_id],
  );

  if (admins.length === 0) {
    logger.warn(
      { tenantId: invoice.tenant_id, invoiceNumber: invoice.invoice_number },
      'invoice issued to a hospital with no active administrator; nobody was notified',
    );
    return 0;
  }

  // The link carries its own authority so it opens from a mail client with
  // no session. See security/download-tokens.ts.
  const payload = JSON.stringify({
    invoiceNumber: invoice.invoice_number,
    hospitalName: invoice.tenant_name,
    tier: invoice.tier,
    amount: formatAmount(invoice.total_cents, invoice.currency),
    dueDate: formatDay(invoice.due_on),
    periodStart: formatDay(invoice.period_start),
    periodEnd: formatDay(invoice.period_end),
    invoiceUrl: invoiceDownloadUrl(invoice.id, invoice.tenant_id),
  });

  for (const admin of admins) {
    for (const channel of ['in_app', 'email'] as const) {
      await db.query(
        `INSERT INTO notifications
           (tenant_id, user_id, channel, template_key, category, priority, payload, dedupe_key)
         VALUES ($1, $2, $3, 'subscription_invoice_issued', 'billing', 4, $4, $5)
         -- Must name the partial index exactly: uq_notifications_dedupe is
         -- on (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL, and a
         -- conflict target that does not match it infers nothing and throws.
         ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [
          invoice.tenant_id,
          admin.id,
          channel,
          payload,
          // Re-running the generator must not re-notify. The unique index on
          // the invoice period already prevents a duplicate invoice; this
          // guards the case of a retried transaction.
          `sub-invoice:${invoice.id}:${admin.id}:${channel}`,
        ],
      );
    }
  }

  return admins.length;
}

/* ---------------------------------------------------------------------------
 * Reading the ledger
 * ------------------------------------------------------------------------- */

export interface InvoiceQuery {
  tenantId?: string;
  status?: string;
  overdueOnly: boolean;
  page: number;
  pageSize: number;
}

export async function listInvoices(
  input: InvoiceQuery,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  return withoutTenantIsolation('platform console: reading the subscription ledger', async (db) => {
    const filters: string[] = [];
    const params: unknown[] = [];

    if (input.tenantId) {
      params.push(input.tenantId);
      filters.push(`i.tenant_id = $${params.length}`);
    }
    if (input.status) {
      params.push(input.status);
      filters.push(`i.status = $${params.length}`);
    }
    if (input.overdueOnly) filters.push('i.is_overdue');

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const { rows: counts } = await db.query<{ total: string }>(
      `SELECT count(*) AS total FROM v_subscription_invoice_status i ${where}`,
      params,
    );

    params.push(input.pageSize, (input.page - 1) * input.pageSize);

    const { rows } = await db.query(
      `SELECT i.id, i.invoice_number, i.tenant_id, i.tier, i.period_start, i.period_end,
              i.currency, i.amount_cents, i.tax_cents, i.total_cents, i.amount_paid_cents,
              i.balance_cents, i.status, i.is_overdue, i.days_overdue,
              i.issued_on, i.due_on, i.void_reason, i.notes,
              t.display_name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status
         FROM v_subscription_invoice_status i
         JOIN tenants t ON t.id = i.tenant_id
         ${where}
        ORDER BY i.is_overdue DESC, i.issued_on DESC, i.invoice_number DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows, total: Number(counts[0]!.total) };
  });
}

/** See `loadSubscription`: same reason, same rule. */
async function loadInvoice(
  db: Queryable,
  invoiceId: string,
): Promise<Record<string, unknown> | null> {
  {
    const { rows } = await db.query(
      `SELECT i.*, t.display_name AS tenant_name, t.slug AS tenant_slug,
              p.email AS issued_by_email
         FROM v_subscription_invoice_status i
         JOIN tenants t ON t.id = i.tenant_id
         LEFT JOIN platform_users p ON p.id = i.issued_by
        WHERE i.id = $1`,
      [invoiceId],
    );

    const invoice = rows[0];
    if (!invoice) return null;

    const { rows: payments } = await db.query(
      `SELECT pay.id, pay.amount_cents, pay.currency, pay.received_on, pay.method,
              pay.reference, pay.notes, pay.voided_at, pay.void_reason, pay.created_at,
              rec.email AS recorded_by_email
         FROM subscription_payments pay
         LEFT JOIN platform_users rec ON rec.id = pay.recorded_by
        WHERE pay.invoice_id = $1
        ORDER BY pay.received_on DESC, pay.created_at DESC`,
      [invoiceId],
    );

    return { ...invoice, payments };
  }
}

export async function getInvoice(invoiceId: string): Promise<Record<string, unknown> | null> {
  return withoutTenantIsolation('platform console: reading a subscription invoice', (db) =>
    loadInvoice(db, invoiceId),
  );
}

/**
 * The same invoice, loaded for RENDERING rather than for the console.
 *
 * Separate from `getInvoice` so the operator's copy of the PDF is identical
 * to the hospital's. `loadInvoice` lists payments newest first, which is
 * right for "what just happened" in the console, and selects the operator
 * who keyed each one in. Rendering that would produce a document whose rows
 * ran backwards compared to the one the customer downloaded, and which
 * carried a vendor employee's email — from the same invoice.
 */
export async function getInvoiceDocument(
  invoiceId: string,
): Promise<Record<string, unknown> | null> {
  return withoutTenantIsolation('platform console: rendering a subscription invoice', async (db) => {
    const { rows } = await db.query(
      `SELECT i.*, t.display_name AS tenant_name, t.slug AS tenant_slug
         FROM v_subscription_invoice_status i
         JOIN tenants t ON t.id = i.tenant_id
        WHERE i.id = $1`,
      [invoiceId],
    );

    const invoice = rows[0];
    if (!invoice) return null;

    const { rows: payments } = await db.query(CUSTOMER_INVOICE_PAYMENTS_SQL, [invoiceId]);
    return { ...invoice, payments };
  });
}

/**
 * Re-mint the signed link for an invoice.
 *
 * A fresh token each time rather than a stored one: the link is derived from
 * the invoice, so there is nothing to keep, and re-sending an expired one
 * silently would be worse than useless.
 */
export async function downloadLink(
  invoiceId: string,
): Promise<{ url: string; expiresInDays: number }> {
  return withoutTenantIsolation('platform console: minting an invoice download link', async (db) => {
    const { rows } = await db.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM subscription_invoices WHERE id = $1',
      [invoiceId],
    );

    const invoice = rows[0];
    if (!invoice) throw new AppError(404, 'NOT_FOUND', 'That invoice could not be found.');

    return { url: invoiceDownloadUrl(invoiceId, invoice.tenant_id), expiresInDays: 90 };
  });
}

/* ---------------------------------------------------------------------------
 * Payments
 * ------------------------------------------------------------------------- */

export interface PaymentInput {
  amountCents: number;
  receivedOn?: string;
  method: 'bank_transfer' | 'mobile_money' | 'card' | 'cash' | 'cheque' | 'other';
  reference?: string | null;
  notes?: string | null;
}

export async function recordPayment(
  invoiceId: string,
  input: PaymentInput,
  operator: PlatformPrincipal,
  meta: RequestMeta,
): Promise<Record<string, unknown>> {
  return withoutTenantIsolation('platform console: recording a subscription payment', async (db) => {
    const { rows: invoiceRows } = await db.query<{
      id: string;
      tenant_id: string;
      currency: string;
      status: string;
      total_cents: string;
      amount_paid_cents: string;
      invoice_number: string;
    }>(
      `SELECT id, tenant_id, currency, status, total_cents, amount_paid_cents, invoice_number
         FROM subscription_invoices WHERE id = $1 FOR UPDATE`,
      [invoiceId],
    );

    const invoice = invoiceRows[0];
    if (!invoice) throw new AppError(404, 'NOT_FOUND', 'That invoice could not be found.');

    if (invoice.status === 'void') {
      throw new AppError(409, 'CONFLICT', 'That invoice was voided. Nothing is owed against it.');
    }

    const balance = Number(invoice.total_cents) - Number(invoice.amount_paid_cents);

    // Checked here as well as by the trigger, so the message names the actual
    // number rather than surfacing a constraint violation.
    if (input.amountCents > balance) {
      throw new AppError(
        409,
        'PAYMENT_EXCEEDS_BALANCE',
        `That is more than the ${balance} outstanding on this invoice.`,
        {
          issues: [
            {
              field: 'amountCents',
              message: `Outstanding balance is ${balance}. Record an overpayment as a credit against the next invoice instead.`,
            },
          ],
        },
      );
    }

    const { rows } = await db.query(
      `INSERT INTO subscription_payments
         (invoice_id, tenant_id, amount_cents, currency, received_on, method,
          reference, notes, recorded_by)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7, $8, $9)
       RETURNING id, amount_cents, currency, received_on, method, reference, notes, created_at`,
      [
        invoiceId,
        invoice.tenant_id,
        input.amountCents,
        invoice.currency,
        input.receivedOn ?? null,
        input.method,
        input.reference ?? null,
        input.notes ?? null,
        operator.operatorId,
      ],
    );

    await recordPlatformAction(
      db,
      operator,
      {
        action: 'platform.payment_recorded',
        resourceType: 'subscription_payment',
        resourceId: rows[0]!.id as string,
        tenantId: invoice.tenant_id,
        metadata: {
          invoiceNumber: invoice.invoice_number,
          amountCents: input.amountCents,
          currency: invoice.currency,
          method: input.method,
          reference: input.reference ?? undefined,
        },
      },
      meta,
    );

    return (await loadInvoice(db, invoiceId))!;
  });
}

export async function voidPayment(
  paymentId: string,
  reason: string,
  operator: PlatformPrincipal,
  meta: RequestMeta,
): Promise<Record<string, unknown>> {
  return withoutTenantIsolation('platform console: voiding a subscription payment', async (db) => {
    const { rows: existing } = await db.query<{
      id: string;
      invoice_id: string;
      tenant_id: string;
      amount_cents: string;
      voided_at: Date | null;
    }>(
      'SELECT id, invoice_id, tenant_id, amount_cents, voided_at FROM subscription_payments WHERE id = $1 FOR UPDATE',
      [paymentId],
    );

    const payment = existing[0];
    if (!payment) throw new AppError(404, 'NOT_FOUND', 'That payment could not be found.');
    if (payment.voided_at) throw new AppError(409, 'CONFLICT', 'That payment is already voided.');

    await db.query(
      `UPDATE subscription_payments
          SET voided_at = now(), void_reason = $2, voided_by = $3
        WHERE id = $1`,
      [paymentId, reason, operator.operatorId],
    );

    await recordPlatformAction(
      db,
      operator,
      {
        action: 'platform.payment_voided',
        resourceType: 'subscription_payment',
        resourceId: paymentId,
        tenantId: payment.tenant_id,
        metadata: { reason, amountCents: Number(payment.amount_cents) },
      },
      meta,
    );

    return (await loadInvoice(db, payment.invoice_id))!;
  });
}

export async function voidInvoice(
  invoiceId: string,
  reason: string,
  operator: PlatformPrincipal,
  meta: RequestMeta,
): Promise<Record<string, unknown>> {
  return withoutTenantIsolation('platform console: voiding a subscription invoice', async (db) => {
    const { rows: existing } = await db.query<{
      tenant_id: string;
      status: string;
      amount_paid_cents: string;
      invoice_number: string;
    }>(
      'SELECT tenant_id, status, amount_paid_cents, invoice_number FROM subscription_invoices WHERE id = $1 FOR UPDATE',
      [invoiceId],
    );

    const invoice = existing[0];
    if (!invoice) throw new AppError(404, 'NOT_FOUND', 'That invoice could not be found.');
    if (invoice.status === 'void') {
      throw new AppError(409, 'CONFLICT', 'That invoice is already void.');
    }

    // Voiding something already settled would leave a payment attached to a
    // cancelled debt, which is how a ledger stops reconciling.
    if (Number(invoice.amount_paid_cents) > 0) {
      throw new AppError(
        409,
        'CONFLICT',
        'This invoice has payments recorded against it. Void those first if they were recorded in error.',
      );
    }

    await db.query(
      `UPDATE subscription_invoices
          SET status = 'void', voided_at = now(), void_reason = $2
        WHERE id = $1`,
      [invoiceId, reason],
    );

    await recordPlatformAction(
      db,
      operator,
      {
        action: 'platform.invoice_voided',
        resourceType: 'subscription_invoice',
        resourceId: invoiceId,
        tenantId: invoice.tenant_id,
        metadata: { reason, invoiceNumber: invoice.invoice_number },
      },
      meta,
    );

    return (await loadInvoice(db, invoiceId))!;
  });
}

/* ---------------------------------------------------------------------------
 * The numbers
 * ------------------------------------------------------------------------- */

/**
 * Revenue figures, grouped by currency.
 *
 * Never summed across currencies. A single "total revenue" number mixing TZS
 * and USD is worse than no number, because it looks like one.
 */
export async function revenueSummary(): Promise<Record<string, unknown>[]> {
  return withoutTenantIsolation('platform console: subscription revenue summary', async (db) => {
    const { rows } = await db.query(
      `SELECT s.currency,
              count(*) FILTER (WHERE s.status = 'active') AS active_subscriptions,
              count(*) FILTER (WHERE s.status = 'trialing') AS trialing,
              -- Normalised to a monthly figure so annual and monthly plans are
              -- comparable; this is the usual meaning of MRR.
              COALESCE(sum(
                CASE WHEN s.status = 'active'
                     THEN ${EFFECTIVE_AMOUNT_SQL} / CASE WHEN s.billing_interval = 'year' THEN 12 ELSE 1 END
                     ELSE 0 END
              ), 0) AS mrr_cents,
              (SELECT COALESCE(sum(i.total_cents - i.amount_paid_cents), 0)
                 FROM subscription_invoices i
                WHERE i.currency = s.currency AND i.status IN ('issued','partially_paid')
              ) AS outstanding_cents,
              (SELECT COALESCE(sum(i.total_cents - i.amount_paid_cents), 0)
                 FROM subscription_invoices i
                WHERE i.currency = s.currency AND i.status IN ('issued','partially_paid')
                  AND i.due_on < CURRENT_DATE
              ) AS overdue_cents,
              (SELECT count(*) FROM subscription_invoices i
                WHERE i.currency = s.currency AND i.status IN ('issued','partially_paid')
                  AND i.due_on < CURRENT_DATE
              ) AS overdue_invoice_count
         FROM tenant_subscriptions s
         JOIN tenants t ON t.id = s.tenant_id
        WHERE t.status <> 'archived'
        GROUP BY s.currency
        ORDER BY s.currency`,
    );

    return rows;
  });
}
