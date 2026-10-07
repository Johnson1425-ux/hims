-- =============================================================================
-- 0018  Subscription billing: what the HOSPITAL owes the VENDOR
-- -----------------------------------------------------------------------------
-- Not to be confused with 0007, which is what a PATIENT owes a hospital. Those
-- two ledgers share almost nothing and must never be mixed: a hospital's
-- revenue and the vendor's revenue are different companies' money.
--
-- Until now `tenants.subscription_tier` was a label. It sat on the tenant row,
-- the console could change it, it rendered as a badge — and nothing anywhere
-- attached a price to it, issued anything, or recorded a payment.
--
-- THE SHAPE, and the four decisions inside it:
--
--   1. FLAT FEE PER TIER, with a per-hospital override. `subscription_plans`
--      is the price book; `tenant_subscriptions.amount_cents` overrides it for
--      one hospital when a contract was negotiated. NULL there means "whatever
--      the price book says today", which is what you want for the common case
--      and not what you want for a signed deal.
--
--   2. THE INVOICE SNAPSHOTS THE PRICE. `subscription_invoices` carries its own
--      amount and currency, copied at issue. Raising the standard tier next
--      quarter must not silently restate an invoice already sent, and a
--      customer comparing their copy against the system must find them equal.
--
--   3. THE VENDOR'S BILLING CURRENCY IS INDEPENDENT OF THE HOSPITAL'S. A
--      hospital bills its patients in TZS and may well pay the vendor in USD.
--      Reusing `tenants.currency` would conflate the two and make a price book
--      impossible to express.
--
--   4. OVERDUE IS DERIVED, NEVER STORED. It is "issued, past due, not settled"
--      — a function of today's date, so a stored flag would be wrong between
--      midnight and whenever a job next ran. 0007 has an 'overdue' status for
--      the clinical ledger and therefore needs something to set it; this one
--      computes it, and is right at every instant with nothing scheduled.
--
-- WHOSE BOOKS THESE ARE. They carry `tenant_id`, so RLS applies and the 0010
-- assertion is satisfied — but the policy is SELECT-ONLY for the tenant role.
-- A hospital may read its own subscription invoices (a "your plan" page is
-- then a route away) and cannot write a single row of the vendor's ledger.
-- Writes belong to hims_platform, through the audited console.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The price book
-- -----------------------------------------------------------------------------
-- One row per (tier, currency). A deployment selling in two currencies keeps
-- two rows per tier rather than converting at issue time — an exchange rate
-- applied silently at invoicing is a support ticket waiting to happen.
CREATE TABLE subscription_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier             text NOT NULL
                     CHECK (tier IN ('trial','standard','enterprise')),
  currency         char(3) NOT NULL,
  -- bigint, not integer. TZS and UGX have no minor unit, so a figure in them
  -- is a hundred times larger than the same value in a cents currency; an
  -- annual enterprise fee in shillings gets within reach of int4's ceiling.
  amount_cents     bigint NOT NULL CHECK (amount_cents >= 0),
  billing_interval text NOT NULL DEFAULT 'month'
                     CHECK (billing_interval IN ('month','year')),
  -- How long after issue payment is expected. Printed on the invoice.
  payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  description      text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tier, currency, billing_interval)
);
SELECT hims_util.attach_touch_trigger('subscription_plans');

-- The trial tier is free by convention, and the convention is enforced: a
-- priced trial is a contradiction that would issue invoices to hospitals
-- nobody has agreed terms with yet.
ALTER TABLE subscription_plans
  ADD CONSTRAINT chk_trial_is_free
  CHECK (tier <> 'trial' OR amount_cents = 0);

-- -----------------------------------------------------------------------------
-- One hospital's terms
-- -----------------------------------------------------------------------------
CREATE TABLE tenant_subscriptions (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  currency             char(3) NOT NULL,
  billing_interval     text NOT NULL DEFAULT 'month'
                         CHECK (billing_interval IN ('month','year')),
  -- NULL = follow the price book for this hospital's tier. A number here is a
  -- negotiated rate and is deliberately NOT updated when the book changes.
  amount_cents         bigint CHECK (amount_cents IS NULL OR amount_cents >= 0),
  payment_terms_days   integer CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365),

  -- The period the hospital has already been invoiced for. Issuing advances
  -- it, which is what makes the generator idempotent: run it twice in a day
  -- and the second run finds nothing due.
  current_period_start date NOT NULL DEFAULT CURRENT_DATE,
  current_period_end   date NOT NULL,
  -- While set and in the future, nothing is issued.
  trial_ends_on        date,

  status               text NOT NULL DEFAULT 'trialing'
                         CHECK (status IN ('trialing','active','cancelled')),
  cancelled_on         date,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_subscription_period CHECK (current_period_end > current_period_start)
);
SELECT hims_util.attach_touch_trigger('tenant_subscriptions');

CREATE INDEX idx_subscriptions_due ON tenant_subscriptions (current_period_end)
  WHERE status = 'active';

-- -----------------------------------------------------------------------------
-- Invoice numbering, across the vendor's whole book
-- -----------------------------------------------------------------------------
-- `hims_util.next_in_sequence` is keyed per tenant, which is right for MRNs
-- and wrong here: the vendor's invoice numbers are one sequence, and two
-- hospitals must never both receive SUB-2026-0001.
CREATE TABLE subscription_invoice_counter (
  year       integer PRIMARY KEY,
  last_value bigint NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION hims_util.next_subscription_invoice_number()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_year integer := EXTRACT(year FROM CURRENT_DATE)::integer;
  v_next bigint;
BEGIN
  INSERT INTO subscription_invoice_counter (year, last_value)
  VALUES (v_year, 1)
  ON CONFLICT (year)
  DO UPDATE SET last_value = subscription_invoice_counter.last_value + 1
  RETURNING last_value INTO v_next;

  RETURN format('SUB-%s-%s', v_year, lpad(v_next::text, 4, '0'));
END;
$$;

-- -----------------------------------------------------------------------------
-- The invoices
-- -----------------------------------------------------------------------------
CREATE TABLE subscription_invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  invoice_number    text NOT NULL UNIQUE,

  -- What was bought. Snapshotted, per decision (2) above.
  tier              text NOT NULL,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  currency          char(3) NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents >= 0),
  tax_cents         bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents       bigint NOT NULL GENERATED ALWAYS AS (amount_cents + tax_cents) STORED,

  issued_on         date NOT NULL DEFAULT CURRENT_DATE,
  due_on            date NOT NULL,

  -- Maintained by trigger from subscription_payments. Never written by hand.
  amount_paid_cents bigint NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),

  status            text NOT NULL DEFAULT 'issued'
                      CHECK (status IN ('issued','partially_paid','paid','void')),
  -- Deliberately no 'overdue' member: see decision (4). It is computed below.

  void_reason       text,
  voided_at         timestamptz,
  notes             text,
  issued_by         uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_sub_invoice_period CHECK (period_end > period_start),
  CONSTRAINT chk_sub_invoice_due CHECK (due_on >= issued_on),
  CONSTRAINT chk_sub_invoice_void CHECK (
    (status = 'void') = (voided_at IS NOT NULL)
  )
);
SELECT hims_util.attach_touch_trigger('subscription_invoices');

CREATE INDEX idx_sub_invoices_tenant ON subscription_invoices (tenant_id, issued_on DESC);
-- The collections worklist: everything still owed, oldest first.
CREATE INDEX idx_sub_invoices_outstanding ON subscription_invoices (due_on)
  WHERE status IN ('issued','partially_paid');
-- One invoice per hospital per period. The generator relies on this to be
-- safe under a double-click as well as under a double-run.
CREATE UNIQUE INDEX uq_sub_invoice_period
  ON subscription_invoices (tenant_id, period_start, period_end)
  WHERE status <> 'void';

-- -----------------------------------------------------------------------------
-- Payments, recorded by hand
-- -----------------------------------------------------------------------------
-- The hospital pays by bank transfer or mobile money, outside this system; an
-- operator records that it arrived. There is no payment-provider integration
-- and therefore no card data anywhere in this schema, which is the main reason
-- to start here: the ledger is the hard part and it is the same either way.
CREATE TABLE subscription_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    uuid NOT NULL REFERENCES subscription_invoices(id) ON DELETE RESTRICT,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  currency      char(3) NOT NULL,
  received_on   date NOT NULL DEFAULT CURRENT_DATE,
  method        text NOT NULL DEFAULT 'bank_transfer'
                  CHECK (method IN ('bank_transfer','mobile_money','card','cash','cheque','other')),
  -- The transfer reference or mobile-money confirmation code. This is what
  -- reconciliation against a bank statement is actually done on.
  reference     text,
  notes         text,
  recorded_by   uuid REFERENCES platform_users(id) ON DELETE SET NULL,

  -- Corrected by voiding, never by deletion or by a negative row. A payment
  -- that turned out not to have arrived is part of the history of the
  -- account, and a negative payment reads as a refund, which it is not.
  voided_at     timestamptz,
  void_reason   text,
  voided_by     uuid REFERENCES platform_users(id) ON DELETE SET NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_sub_payment_void CHECK ((voided_at IS NOT NULL) = (void_reason IS NOT NULL))
);

CREATE INDEX idx_sub_payments_invoice ON subscription_payments (invoice_id);
CREATE INDEX idx_sub_payments_tenant ON subscription_payments (tenant_id, received_on DESC);

-- -----------------------------------------------------------------------------
-- Keeping the invoice's paid total honest
-- -----------------------------------------------------------------------------
-- Recomputed from the payment rows rather than incremented, so a void is the
-- same code path as an insert and the two can never drift. Enforced in the
-- database because the alternative is trusting every future caller to
-- remember, which is how a ledger stops balancing.
CREATE OR REPLACE FUNCTION hims_util.sync_subscription_invoice_paid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_invoice_id uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
  v_paid       bigint;
  v_total      bigint;
  v_status     text;
BEGIN
  SELECT COALESCE(sum(amount_cents), 0) INTO v_paid
    FROM subscription_payments
   WHERE invoice_id = v_invoice_id AND voided_at IS NULL;

  SELECT total_cents, status INTO v_total, v_status
    FROM subscription_invoices WHERE id = v_invoice_id FOR UPDATE;

  IF v_paid > v_total THEN
    RAISE EXCEPTION
      'payment of % exceeds the % outstanding on this invoice', v_paid, v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- A voided invoice keeps whatever status it has; reviving it by paying
  -- against it would hide the void.
  UPDATE subscription_invoices
     SET amount_paid_cents = v_paid,
         status = CASE
                    WHEN v_status = 'void' THEN 'void'
                    WHEN v_paid = 0 THEN 'issued'
                    WHEN v_paid >= total_cents THEN 'paid'
                    ELSE 'partially_paid'
                  END
   WHERE id = v_invoice_id;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_sync_subscription_paid
  AFTER INSERT OR UPDATE OR DELETE ON subscription_payments
  FOR EACH ROW EXECUTE FUNCTION hims_util.sync_subscription_invoice_paid();

-- -----------------------------------------------------------------------------
-- Overdue, computed
-- -----------------------------------------------------------------------------
-- A view rather than a column, so it cannot be stale. `days_overdue` is what
-- the console sorts its collections list by.
CREATE VIEW v_subscription_invoice_status
WITH (security_invoker = true) AS
SELECT i.*,
       (i.total_cents - i.amount_paid_cents) AS balance_cents,
       (i.status IN ('issued','partially_paid') AND i.due_on < CURRENT_DATE) AS is_overdue,
       GREATEST(0, CURRENT_DATE - i.due_on) AS days_overdue
  FROM subscription_invoices i;

-- -----------------------------------------------------------------------------
-- Row-level security: a hospital may read its own, and write none of it
-- -----------------------------------------------------------------------------
-- RLS is ENABLED but deliberately NOT FORCE'd, which is the opposite of the
-- clinical tables and worth the explanation.
--
-- FORCE subjects the TABLE OWNER to the policies as well, and the owner here
-- is the deploy-time role that runs migrations and the seed. With FORCE on,
-- the backfill further down this very file cannot insert a row — it would
-- have failed the migration on any installation that already has hospitals,
-- and passed silently on an empty one, which is the worst way to find out.
--
-- Nothing is given up by lifting it. hims_app is NOT the owner, so RLS
-- applies to it in full: the policies below filter its reads to its own
-- tenant, and the REVOKE further down removes INSERT, UPDATE and DELETE
-- outright. The write protection on these tables is a GRANT, not a policy,
-- and a GRANT does not care about FORCE.
ALTER TABLE subscription_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY sub_invoices_read ON subscription_invoices FOR SELECT
  USING (tenant_id = hims_util.current_tenant_id());

ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY sub_payments_read ON subscription_payments FOR SELECT
  USING (tenant_id = hims_util.current_tenant_id());

ALTER TABLE tenant_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_subscriptions_read ON tenant_subscriptions FOR SELECT
  USING (tenant_id = hims_util.current_tenant_id());

-- The policies above grant SELECT only; with no INSERT/UPDATE/DELETE policy,
-- those commands return zero rows for a tenant connection whatever it tries.
-- The grants are narrowed to match, so the refusal is a privilege error rather
-- than a silent no-op — a hospital's request should fail loudly if it ever
-- tries to write the vendor's books.
REVOKE INSERT, UPDATE, DELETE
  ON subscription_invoices, subscription_payments, tenant_subscriptions
  FROM hims_app;

-- The price book is not tenant data at all: no tenant_id, no RLS, and the
-- tenant role has no business reading what other hospitals are charged.
REVOKE ALL ON subscription_plans, subscription_invoice_counter FROM hims_app, hims_analytics;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON subscription_plans, subscription_invoice_counter TO hims_platform;

-- -----------------------------------------------------------------------------
-- A starting price book
-- -----------------------------------------------------------------------------
-- Figures are placeholders and are editable from the console. They exist so a
-- fresh install can issue an invoice without first filling in a form, and so
-- the shape of the table is obvious from the data.
INSERT INTO subscription_plans (tier, currency, amount_cents, billing_interval, payment_terms_days, description)
VALUES
  ('trial',      'TZS',         0, 'month', 30, 'Evaluation. No charge, no invoices issued.'),
  ('standard',   'TZS',   750000, 'month', 30, 'Single hospital, unlimited staff.'),
  ('enterprise', 'TZS',  2500000, 'month', 30, 'Multi-site groups, with a named support contact.'),
  ('trial',      'USD',         0, 'month', 30, 'Evaluation. No charge, no invoices issued.'),
  ('standard',   'USD',     29900, 'month', 30, 'Single hospital, unlimited staff.'),
  ('enterprise', 'USD',     99900, 'month', 30, 'Multi-site groups, with a named support contact.');

-- -----------------------------------------------------------------------------
-- Terms for the hospitals that already exist
-- -----------------------------------------------------------------------------
-- Every tenant provisioned before this migration has no subscription row, and
-- a hospital invisible to the billing run is a hospital nobody ever bills.
-- Provisioning creates the row from now on; this catches the rest.
--
-- `current_period_end` is "paid up to", and the generator issues for the
-- period starting there. Setting it to today means the first run bills the
-- month ahead rather than silently backdating a charge nobody agreed to.
INSERT INTO tenant_subscriptions
  (tenant_id, currency, billing_interval, current_period_start, current_period_end,
   trial_ends_on, status, notes)
SELECT t.id,
       t.currency,
       'month',
       CURRENT_DATE - interval '1 month',
       CURRENT_DATE,
       CASE WHEN t.subscription_tier = 'trial' THEN CURRENT_DATE + 30 END,
       CASE WHEN t.subscription_tier = 'trial' THEN 'trialing' ELSE 'active' END,
       'Terms created when subscription billing was introduced.'
  FROM tenants t
 WHERE t.status <> 'archived'
ON CONFLICT (tenant_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Guard rail: the tenant role must not be able to write the vendor's ledger
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_leak text[];
BEGIN
  SELECT array_agg(DISTINCT table_name || '.' || lower(privilege_type))
    INTO v_leak
    FROM information_schema.role_table_grants
   WHERE grantee = 'hims_app'
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
     AND table_name IN ('subscription_invoices', 'subscription_payments',
                        'tenant_subscriptions', 'subscription_plans');

  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION
      'the tenant role can still write the vendor ledger: %',
      array_to_string(v_leak, ', ');
  END IF;
END;
$$;
