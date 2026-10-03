-- =============================================================================
-- 0007  Billing, invoicing, payments and insurance claims
-- -----------------------------------------------------------------------------
-- Money is stored as integer minor units (cents). No floats anywhere: a
-- rounding drift of one cent per line across a year of claims is a reconciliation
-- nightmare, and payers reject remittances that do not balance to the cent.
--
-- Invoice totals are maintained by trigger from `invoice_lines`, so the header
-- can never disagree with its lines regardless of which code path writes them.
-- =============================================================================

-- Billable catalogue: consultations, procedures, drugs, bed-days, consumables.
CREATE TABLE service_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  description     text,
  category        text NOT NULL DEFAULT 'consultation'
                    CHECK (category IN ('consultation','procedure','diagnostic','medication',
                                        'consumable','bed_charge','ambulance','admin_fee','package')),
  -- Payer-facing codes. CPT/HCPCS for US billing, local tariff elsewhere.
  cpt_code        text,
  hcpcs_code      text,
  revenue_code    text,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  unit            text NOT NULL DEFAULT 'each',
  tax_rate        numeric(5,4) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 1),
  is_taxable      boolean NOT NULL DEFAULT false,
  -- Whether this line is normally claimable from insurance.
  insurance_eligible boolean NOT NULL DEFAULT true,
  department_id   uuid REFERENCES departments(id) ON DELETE SET NULL,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT hims_util.attach_touch_trigger('service_items');
CREATE INDEX idx_service_items_category ON service_items (tenant_id, category) WHERE is_active;

ALTER TABLE appointment_types
  ADD CONSTRAINT fk_appointment_type_service_item
  FOREIGN KEY (default_service_item_id) REFERENCES service_items(id) ON DELETE SET NULL;

-- Negotiated rates per payer; the pricing engine prefers these over list price.
CREATE TABLE payer_price_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payer_id        uuid NOT NULL REFERENCES insurance_payers(id) ON DELETE CASCADE,
  service_item_id uuid NOT NULL REFERENCES service_items(id) ON DELETE CASCADE,
  allowed_amount_cents integer NOT NULL CHECK (allowed_amount_cents >= 0),
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  effective_until date,
  UNIQUE (payer_id, service_item_id, effective_from)
);

-- -----------------------------------------------------------------------------
-- Invoices
-- -----------------------------------------------------------------------------
CREATE TABLE invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_number     text NOT NULL,
  patient_id         uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  encounter_id       uuid REFERENCES encounters(id) ON DELETE SET NULL,
  appointment_id     uuid REFERENCES appointments(id) ON DELETE SET NULL,
  facility_id        uuid REFERENCES facilities(id) ON DELETE SET NULL,

  currency           char(3) NOT NULL DEFAULT 'USD',
  issued_on          date NOT NULL DEFAULT CURRENT_DATE,
  due_on             date,

  -- Maintained by trigger from invoice_lines. Never written by hand.
  subtotal_cents     integer NOT NULL DEFAULT 0,
  discount_cents     integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_cents          integer NOT NULL DEFAULT 0,
  total_cents        integer NOT NULL DEFAULT 0,
  -- Split of `total_cents` between payer and patient after adjudication.
  insurance_portion_cents integer NOT NULL DEFAULT 0 CHECK (insurance_portion_cents >= 0),
  patient_portion_cents   integer NOT NULL DEFAULT 0 CHECK (patient_portion_cents >= 0),
  -- Maintained by trigger from payment_allocations.
  amount_paid_cents  integer NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  balance_cents      integer NOT NULL DEFAULT 0,

  status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','issued','partially_paid','paid',
                                         'overdue','void','written_off','refunded')),
  -- Where the bill currently sits in the revenue cycle.
  billing_stage      text NOT NULL DEFAULT 'pending_coding'
                       CHECK (billing_stage IN ('pending_coding','ready_to_bill','with_insurer',
                                                'patient_responsibility','in_collections','closed')),
  primary_policy_id  uuid REFERENCES patient_insurance_policies(id) ON DELETE SET NULL,
  notes              text,
  pdf_document_id    uuid REFERENCES documents(id) ON DELETE SET NULL,
  void_reason        text,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_invoice_due CHECK (due_on IS NULL OR due_on >= issued_on),
  CONSTRAINT chk_invoice_split
    CHECK (insurance_portion_cents + patient_portion_cents <= total_cents + discount_cents)
);
SELECT hims_util.attach_touch_trigger('invoices');

CREATE UNIQUE INDEX uq_invoices_number ON invoices (tenant_id, invoice_number);
CREATE INDEX idx_invoices_patient ON invoices (patient_id, issued_on DESC);
-- The accounts-receivable worklist.
CREATE INDEX idx_invoices_outstanding ON invoices (tenant_id, due_on)
  WHERE status IN ('issued','partially_paid','overdue');
CREATE INDEX idx_invoices_stage ON invoices (tenant_id, billing_stage, issued_on);

CREATE TABLE invoice_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id      uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no         integer NOT NULL,
  service_item_id uuid REFERENCES service_items(id) ON DELETE SET NULL,
  -- Snapshot of the catalogue at billing time: the price on an issued invoice
  -- must not shift when someone edits the catalogue next month.
  description     text NOT NULL,
  cpt_code        text,
  quantity        numeric(10,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  discount_cents  integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_rate        numeric(5,4) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 1),
  -- Generated so the arithmetic exists in exactly one place.
  gross_cents     integer GENERATED ALWAYS AS (round(quantity * unit_price_cents)::integer) STORED,
  net_cents       integer GENERATED ALWAYS AS (
                    round(quantity * unit_price_cents)::integer - discount_cents
                  ) STORED,
  tax_cents       integer GENERATED ALWAYS AS (
                    round((round(quantity * unit_price_cents)::integer - discount_cents) * tax_rate)::integer
                  ) STORED,
  -- Diagnosis pointer(s) justifying this charge, required on most claims.
  diagnosis_codes text[] NOT NULL DEFAULT '{}',
  is_insurance_eligible boolean NOT NULL DEFAULT true,
  -- Links a dispensed drug or performed test back to its clinical origin.
  source_kind     text CHECK (source_kind IN ('appointment','encounter','prescription',
                                              'diagnostic_order','dispense','manual')),
  source_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, line_no)
);
CREATE INDEX idx_invoice_lines_invoice ON invoice_lines (invoice_id);
CREATE INDEX idx_invoice_lines_source ON invoice_lines (source_kind, source_id)
  WHERE source_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Payments. A payment is money received; `payment_allocations` says which
-- invoices it settled, which keeps part-payments and credits honest.
-- -----------------------------------------------------------------------------
CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_number   text NOT NULL,
  patient_id       uuid REFERENCES patients(id) ON DELETE SET NULL,
  payer_id         uuid REFERENCES insurance_payers(id) ON DELETE SET NULL,
  payer_kind       text NOT NULL DEFAULT 'patient'
                     CHECK (payer_kind IN ('patient','insurance','employer','ngo','government','other')),
  amount_cents     integer NOT NULL CHECK (amount_cents <> 0),
  currency         char(3) NOT NULL DEFAULT 'USD',
  method           text NOT NULL
                     CHECK (method IN ('cash','card','bank_transfer','mobile_money','cheque',
                                       'insurance_remittance','credit_note','writeoff')),
  -- Gateway identifiers only; no PAN, no CVV. Card data never enters this system.
  gateway          text,
  gateway_reference text,
  card_last4       char(4),
  received_at      timestamptz NOT NULL DEFAULT now(),
  received_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'settled'
                     CHECK (status IN ('pending','settled','failed','reversed','refunded')),
  -- Negative-amount rows are refunds and point at the original payment.
  reverses_payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
SELECT hims_util.attach_touch_trigger('payments');
CREATE UNIQUE INDEX uq_payments_receipt ON payments (tenant_id, receipt_number);
CREATE INDEX idx_payments_patient ON payments (patient_id, received_at DESC);
CREATE INDEX idx_payments_daybook ON payments (tenant_id, received_at);

CREATE TABLE payment_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id  uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents <> 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, invoice_id)
);
CREATE INDEX idx_allocations_invoice ON payment_allocations (invoice_id);

-- -----------------------------------------------------------------------------
-- Insurance claims (X12 837 lifecycle)
-- -----------------------------------------------------------------------------
CREATE TABLE insurance_claims (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  claim_number     text NOT NULL,
  invoice_id       uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  patient_id       uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  policy_id        uuid NOT NULL REFERENCES patient_insurance_policies(id) ON DELETE RESTRICT,
  payer_id         uuid NOT NULL REFERENCES insurance_payers(id) ON DELETE RESTRICT,

  claimed_cents    integer NOT NULL CHECK (claimed_cents >= 0),
  -- Adjudication outcome from the 835 remittance.
  allowed_cents    integer CHECK (allowed_cents >= 0),
  approved_cents   integer CHECK (approved_cents >= 0),
  paid_cents       integer CHECK (paid_cents >= 0),
  patient_responsibility_cents integer CHECK (patient_responsibility_cents >= 0),
  denied_cents     integer CHECK (denied_cents >= 0),

  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','ready','submitted','acknowledged','in_review',
                                       'approved','partially_approved','denied','appealed',
                                       'paid','closed','void')),
  -- Payer-side identifiers for follow-up calls.
  payer_claim_control_number text,
  clearinghouse_id text,
  submission_format text NOT NULL DEFAULT 'x12_837p'
                     CHECK (submission_format IN ('x12_837p','x12_837i','portal','paper')),
  submitted_at     timestamptz,
  acknowledged_at  timestamptz,
  adjudicated_at   timestamptz,
  -- CARC/RARC denial codes, kept structured so the denial dashboard can trend them.
  denial_codes     jsonb NOT NULL DEFAULT '[]'::jsonb,
  denial_narrative text,
  -- Appeals: a resubmission points back at the claim it supersedes.
  appeal_of_claim_id uuid REFERENCES insurance_claims(id) ON DELETE SET NULL,
  appeal_deadline  date,
  -- Prior authorisation, where the payer required one up front.
  prior_auth_number text,
  submitted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  raw_request      jsonb,
  raw_response     jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_claim_amounts
    CHECK (approved_cents IS NULL OR allowed_cents IS NULL OR approved_cents <= allowed_cents)
);
SELECT hims_util.attach_touch_trigger('insurance_claims');
CREATE UNIQUE INDEX uq_claims_number ON insurance_claims (tenant_id, claim_number);
CREATE INDEX idx_claims_invoice ON insurance_claims (invoice_id);
-- Claims follow-up worklist: anything sent but not yet adjudicated.
CREATE INDEX idx_claims_open ON insurance_claims (tenant_id, payer_id, submitted_at)
  WHERE status IN ('submitted','acknowledged','in_review','appealed');
CREATE INDEX idx_claims_denials ON insurance_claims USING gin (denial_codes jsonb_path_ops);

CREATE TABLE claim_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  claim_id        uuid NOT NULL REFERENCES insurance_claims(id) ON DELETE CASCADE,
  invoice_line_id uuid REFERENCES invoice_lines(id) ON DELETE SET NULL,
  line_no         integer NOT NULL,
  cpt_code        text NOT NULL,
  modifiers       text[] NOT NULL DEFAULT '{}',
  diagnosis_pointers text[] NOT NULL DEFAULT '{}',
  units           numeric(10,3) NOT NULL DEFAULT 1 CHECK (units > 0),
  charged_cents   integer NOT NULL CHECK (charged_cents >= 0),
  allowed_cents   integer,
  paid_cents      integer,
  adjustment_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  service_date    date NOT NULL,
  UNIQUE (claim_id, line_no)
);
CREATE INDEX idx_claim_lines_claim ON claim_lines (claim_id);

-- -----------------------------------------------------------------------------
-- Keep invoice headers in step with their lines and payments.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hims_util.recalculate_invoice(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_subtotal integer;
  v_discount integer;
  v_tax      integer;
  v_paid     integer;
  v_total    integer;
BEGIN
  SELECT COALESCE(SUM(gross_cents), 0),
         COALESCE(SUM(discount_cents), 0),
         COALESCE(SUM(tax_cents), 0)
    INTO v_subtotal, v_discount, v_tax
    FROM invoice_lines WHERE invoice_id = p_invoice_id;

  SELECT COALESCE(SUM(pa.amount_cents), 0)
    INTO v_paid
    FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id
   WHERE pa.invoice_id = p_invoice_id
     AND p.status IN ('settled','pending');

  v_total := v_subtotal - v_discount + v_tax;

  UPDATE invoices
     SET subtotal_cents    = v_subtotal,
         discount_cents    = v_discount,
         tax_cents         = v_tax,
         total_cents       = v_total,
         amount_paid_cents = v_paid,
         balance_cents     = v_total - v_paid,
         -- Only advance status automatically out of the live billing states;
         -- draft, void and written-off are deliberate human decisions.
         status = CASE
                    WHEN status IN ('draft','void','written_off','refunded') THEN status
                    WHEN v_total - v_paid <= 0 AND v_total > 0 THEN 'paid'
                    WHEN v_paid > 0 THEN 'partially_paid'
                    WHEN due_on IS NOT NULL AND due_on < CURRENT_DATE THEN 'overdue'
                    ELSE 'issued'
                  END,
         updated_at = now()
   WHERE id = p_invoice_id;
END;
$$;

CREATE OR REPLACE FUNCTION hims_util.sync_invoice_from_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM hims_util.recalculate_invoice(COALESCE(NEW.invoice_id, OLD.invoice_id));
  RETURN NULL;   -- AFTER trigger; return value is ignored
END;
$$;

CREATE TRIGGER trg_invoice_lines_sync
  AFTER INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION hims_util.sync_invoice_from_lines();

CREATE TRIGGER trg_payment_allocations_sync
  AFTER INSERT OR UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION hims_util.sync_invoice_from_lines();

-- Over-allocation guard. Without this, a double-keyed receipt drives
-- balance_cents negative and the invoice reports 'paid' while the ledger says
-- the hospital owes money back — a reconciliation defect that is painful to
-- unwind months later. Genuine overpayments belong on a patient credit
-- balance, not on the invoice that happened to be open at the till.
CREATE OR REPLACE FUNCTION hims_util.guard_allocation_total()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_total     integer;
  v_allocated integer;
BEGIN
  SELECT total_cents INTO v_total FROM invoices WHERE id = NEW.invoice_id FOR SHARE;

  SELECT COALESCE(SUM(amount_cents), 0) INTO v_allocated
    FROM payment_allocations
   WHERE invoice_id = NEW.invoice_id
     AND id <> NEW.id;

  IF v_allocated + NEW.amount_cents > v_total THEN
    RAISE EXCEPTION
      'allocating % to invoice % would exceed its total (already allocated %, total %)',
      NEW.amount_cents, NEW.invoice_id, v_allocated, v_total
      USING ERRCODE = 'check_violation',
            HINT = 'post the excess as a patient credit instead of over-allocating';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_allocation_total
  BEFORE INSERT OR UPDATE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION hims_util.guard_allocation_total();
