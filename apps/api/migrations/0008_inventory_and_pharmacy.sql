-- =============================================================================
-- 0008  Inventory, pharmacy and prescribing
-- -----------------------------------------------------------------------------
-- Stock is modelled as an append-only LEDGER (`stock_movements`) with a
-- trigger-maintained BALANCE (`stock_levels`). Writing balances directly is the
-- usual source of phantom stock: a failed dispense that already decremented a
-- counter leaves the shelf and the system permanently out of step. Here every
-- balance is reconstructible by replaying the ledger, which is also what the
-- controlled-drug register requires.
-- =============================================================================

CREATE TABLE suppliers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           text NOT NULL,
  code           text NOT NULL,
  contact_name   text,
  contact_email  text,
  contact_phone  text,
  address        text,
  tax_id         text,
  payment_terms_days integer NOT NULL DEFAULT 30,
  lead_time_days integer NOT NULL DEFAULT 7,
  is_preferred   boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT hims_util.attach_touch_trigger('suppliers');

-- Physical stores: main pharmacy, ward cupboard, theatre store, cold chain.
CREATE TABLE inventory_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id uuid REFERENCES facilities(id) ON DELETE CASCADE,
  name        text NOT NULL,
  code        text NOT NULL,
  kind        text NOT NULL DEFAULT 'pharmacy'
                CHECK (kind IN ('pharmacy','ward','theatre','lab','store','cold_chain','controlled_cabinet')),
  -- Controlled substances may only sit in a location flagged for them.
  allows_controlled boolean NOT NULL DEFAULT false,
  temperature_controlled boolean NOT NULL DEFAULT false,
  managed_by  uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- -----------------------------------------------------------------------------
-- Catalogue: drugs and consumables share one table because they share one
-- stock ledger; `is_medication` splits the pharmacy-specific behaviour.
-- -----------------------------------------------------------------------------
CREATE TABLE inventory_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku               text NOT NULL,
  name              text NOT NULL,
  is_medication     boolean NOT NULL DEFAULT true,
  category          text NOT NULL DEFAULT 'medication'
                      CHECK (category IN ('medication','vaccine','consumable','reagent',
                                          'instrument','ppe','implant','other')),
  -- Medication identity
  generic_name      text,
  brand_name        text,
  -- RxNorm concept id (US) or ATC code; drives interaction checking.
  rxnorm_code       text,
  atc_code          text,
  form              text CHECK (form IN ('tablet','capsule','syrup','suspension','injection',
                                         'infusion','cream','ointment','drops','inhaler',
                                         'patch','suppository','powder')),
  strength          text,                    -- '500 mg', '5 mg/mL'
  route             text,                    -- 'oral', 'IV', 'topical'
  -- Controlled-substance schedule; non-null means extra custody rules apply.
  controlled_schedule text CHECK (controlled_schedule IN ('I','II','III','IV','V')),
  requires_prescription boolean NOT NULL DEFAULT true,
  requires_cold_chain boolean NOT NULL DEFAULT false,
  is_high_alert     boolean NOT NULL DEFAULT false,   -- insulin, heparin, opioids

  -- Units: stock is counted in `base_unit`; purchasing may use packs.
  base_unit         text NOT NULL DEFAULT 'each',
  pack_size         integer NOT NULL DEFAULT 1 CHECK (pack_size > 0),

  -- Replenishment policy
  reorder_level     numeric(12,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  reorder_quantity  numeric(12,3) NOT NULL DEFAULT 0 CHECK (reorder_quantity >= 0),
  critical_level    numeric(12,3) NOT NULL DEFAULT 0 CHECK (critical_level >= 0),
  max_level         numeric(12,3),
  -- Average daily consumption, refreshed nightly; feeds days-of-cover.
  avg_daily_usage   numeric(12,3) NOT NULL DEFAULT 0,

  -- Costing and pricing
  cost_price_cents  integer NOT NULL DEFAULT 0 CHECK (cost_price_cents >= 0),
  sale_price_cents  integer NOT NULL DEFAULT 0 CHECK (sale_price_cents >= 0),
  service_item_id   uuid REFERENCES service_items(id) ON DELETE SET NULL,
  preferred_supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,

  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku),
  CONSTRAINT chk_item_levels CHECK (critical_level <= reorder_level),
  CONSTRAINT chk_medication_fields
    CHECK (NOT is_medication OR generic_name IS NOT NULL)
);
SELECT hims_util.attach_touch_trigger('inventory_items');
CREATE INDEX idx_inventory_items_name_trgm ON inventory_items USING gin (name gin_trgm_ops);
CREATE INDEX idx_inventory_items_generic ON inventory_items (tenant_id, generic_name)
  WHERE is_medication AND is_active;
CREATE INDEX idx_inventory_items_controlled ON inventory_items (tenant_id)
  WHERE controlled_schedule IS NOT NULL;

ALTER TABLE patient_allergies
  ADD CONSTRAINT fk_allergy_medication
  FOREIGN KEY (medication_id) REFERENCES inventory_items(id) ON DELETE SET NULL;

-- Lot/batch with its own expiry: the unit that FEFO picking and recalls act on.
CREATE TABLE stock_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  location_id   uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  lot_number    text NOT NULL,
  expires_on    date,
  received_on   date NOT NULL DEFAULT CURRENT_DATE,
  supplier_id   uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  unit_cost_cents integer NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  quantity_received numeric(12,3) NOT NULL CHECK (quantity_received > 0),
  -- Maintained by the ledger trigger; never written directly.
  quantity_on_hand numeric(12,3) NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  status        text NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available','quarantined','expired','recalled','depleted')),
  recall_reference text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, location_id, lot_number)
);
SELECT hims_util.attach_touch_trigger('stock_batches');
-- First-expiry-first-out picking order.
CREATE INDEX idx_batches_fefo ON stock_batches (item_id, location_id, expires_on NULLS LAST)
  WHERE status = 'available' AND quantity_on_hand > 0;
CREATE INDEX idx_batches_expiring ON stock_batches (tenant_id, expires_on)
  WHERE status = 'available' AND quantity_on_hand > 0;

-- Rolled-up balance per (item, location). The one row the UI reads.
CREATE TABLE stock_levels (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id          uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  location_id      uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  quantity_on_hand numeric(12,3) NOT NULL DEFAULT 0,
  -- Reserved by an unfilled prescription or picking list.
  quantity_reserved numeric(12,3) NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
  quantity_available numeric(12,3) GENERATED ALWAYS AS
                       (quantity_on_hand - quantity_reserved) STORED,
  last_movement_at timestamptz,
  last_counted_at  timestamptz,
  PRIMARY KEY (item_id, location_id)
);
CREATE INDEX idx_stock_levels_tenant ON stock_levels (tenant_id);

-- The ledger. Append-only: corrections are compensating entries.
CREATE TABLE stock_movements (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  location_id   uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  batch_id      uuid REFERENCES stock_batches(id) ON DELETE RESTRICT,
  -- Signed quantity: positive adds to stock, negative removes.
  quantity      numeric(12,3) NOT NULL CHECK (quantity <> 0),
  movement_type text NOT NULL
                  CHECK (movement_type IN ('receipt','dispense','administer','return',
                                           'transfer_in','transfer_out','adjustment',
                                           'wastage','expiry','recall','stock_take')),
  -- Why, and what clinical or purchasing event caused it.
  reason        text,
  reference_kind text CHECK (reference_kind IN ('purchase_order','dispense','prescription',
                                               'encounter','transfer','stock_take','manual')),
  reference_id  uuid,
  unit_cost_cents integer,
  -- Running balance snapshot, so the register prints without a window function.
  balance_after numeric(12,3) NOT NULL,
  performed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Controlled drugs need a second signature at the cabinet.
  witnessed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_movements_item_time ON stock_movements (item_id, occurred_at DESC);
CREATE INDEX idx_movements_tenant_time ON stock_movements (tenant_id, occurred_at DESC);
CREATE INDEX idx_movements_reference ON stock_movements (reference_kind, reference_id)
  WHERE reference_id IS NOT NULL;

-- Apply a ledger entry to the batch and the rolled-up balance, and stamp the
-- running balance onto the row being inserted.
CREATE OR REPLACE FUNCTION hims_util.apply_stock_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance numeric(12,3);
BEGIN
  -- Lock the balance row (creating it on first movement) to serialise concurrent
  -- dispenses of the same item at the same location.
  INSERT INTO stock_levels (tenant_id, item_id, location_id, quantity_on_hand, last_movement_at)
  VALUES (NEW.tenant_id, NEW.item_id, NEW.location_id, 0, NEW.occurred_at)
  ON CONFLICT (item_id, location_id) DO UPDATE
     SET last_movement_at = GREATEST(stock_levels.last_movement_at, EXCLUDED.last_movement_at);

  SELECT quantity_on_hand INTO v_balance
    FROM stock_levels
   WHERE item_id = NEW.item_id AND location_id = NEW.location_id
     FOR UPDATE;

  v_balance := v_balance + NEW.quantity;

  IF v_balance < 0 THEN
    RAISE EXCEPTION
      'stock movement would drive % at % negative (have %, requested %)',
      NEW.item_id, NEW.location_id, v_balance - NEW.quantity, NEW.quantity
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE stock_levels
     SET quantity_on_hand = v_balance,
         last_movement_at = NEW.occurred_at
   WHERE item_id = NEW.item_id AND location_id = NEW.location_id;

  IF NEW.batch_id IS NOT NULL THEN
    UPDATE stock_batches
       SET quantity_on_hand = quantity_on_hand + NEW.quantity,
           status = CASE
                      WHEN quantity_on_hand + NEW.quantity <= 0 AND status = 'available'
                        THEN 'depleted'
                      ELSE status
                    END,
           updated_at = now()
     WHERE id = NEW.batch_id;
  END IF;

  NEW.balance_after := v_balance;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_apply_stock_movement
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION hims_util.apply_stock_movement();

-- Ledger immutability: the controlled-drug register must not be rewritable.
-- Shared by every append-only table (stock_movements, audit_events), so the
-- message names whichever one the caller actually tried to rewrite.
CREATE OR REPLACE FUNCTION hims_util.reject_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only (attempted %); post a compensating entry instead',
    TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER trg_stock_movements_immutable
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION hims_util.reject_ledger_mutation();

-- -----------------------------------------------------------------------------
-- Low-stock alerting. The view is the single definition of "low"; the worker
-- materialises unseen breaches into `stock_alerts` so each one notifies once.
-- -----------------------------------------------------------------------------
-- SECURITY_INVOKER IS NOT OPTIONAL HERE.
--
-- By default a PostgreSQL view executes with the permissions of its OWNER, so
-- row-level security on the underlying tables is evaluated as the owner and
-- every tenant's stock is returned to every caller. `security_invoker = true`
-- (PostgreSQL 15+) makes the view evaluate as the querying role instead, so
-- the policies on stock_levels, inventory_items and inventory_locations apply
-- normally. Migration 0010 asserts that every view in this schema sets it.
CREATE VIEW v_stock_status WITH (security_invoker = true) AS
SELECT
  sl.tenant_id,
  sl.item_id,
  sl.location_id,
  i.sku,
  i.name,
  i.category,
  i.base_unit,
  i.is_medication,
  i.controlled_schedule,
  loc.name AS location_name,
  sl.quantity_on_hand,
  sl.quantity_reserved,
  sl.quantity_available,
  i.reorder_level,
  i.critical_level,
  i.reorder_quantity,
  i.avg_daily_usage,
  CASE
    WHEN i.avg_daily_usage > 0
      THEN round(sl.quantity_available / i.avg_daily_usage, 1)
  END AS days_of_cover,
  CASE
    WHEN sl.quantity_available <= 0                 THEN 'out_of_stock'
    WHEN sl.quantity_available <= i.critical_level  THEN 'critical'
    WHEN sl.quantity_available <= i.reorder_level   THEN 'low'
    WHEN i.max_level IS NOT NULL
         AND sl.quantity_available > i.max_level    THEN 'overstocked'
    ELSE 'ok'
  END AS stock_state,
  (SELECT min(b.expires_on)
     FROM stock_batches b
    WHERE b.item_id = sl.item_id
      AND b.location_id = sl.location_id
      AND b.status = 'available'
      AND b.quantity_on_hand > 0) AS earliest_expiry
FROM stock_levels sl
JOIN inventory_items i ON i.id = sl.item_id
JOIN inventory_locations loc ON loc.id = sl.location_id
WHERE i.is_active;

CREATE TABLE stock_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id      uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  location_id  uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  alert_type   text NOT NULL
                 CHECK (alert_type IN ('low_stock','critical_stock','out_of_stock',
                                       'expiring_soon','expired','recall','overstocked')),
  severity     text NOT NULL DEFAULT 'warning'
                 CHECK (severity IN ('info','warning','critical')),
  quantity_at_alert numeric(12,3),
  threshold    numeric(12,3),
  message      text NOT NULL,
  batch_id     uuid REFERENCES stock_batches(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','acknowledged','ordered','resolved','suppressed')),
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- One open alert of a given type per item/location: no notification storms.
CREATE UNIQUE INDEX uq_stock_alert_open
  ON stock_alerts (item_id, location_id, alert_type) WHERE status IN ('open','acknowledged');
CREATE INDEX idx_stock_alerts_open ON stock_alerts (tenant_id, severity, created_at DESC)
  WHERE status = 'open';

-- -----------------------------------------------------------------------------
-- Purchase orders
-- -----------------------------------------------------------------------------
CREATE TABLE purchase_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  po_number      text NOT NULL,
  supplier_id    uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  location_id    uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','pending_approval','approved','sent',
                                     'partially_received','received','cancelled')),
  currency       char(3) NOT NULL DEFAULT 'USD',
  subtotal_cents integer NOT NULL DEFAULT 0,
  tax_cents      integer NOT NULL DEFAULT 0,
  total_cents    integer NOT NULL DEFAULT 0,
  expected_on    date,
  ordered_at     timestamptz,
  received_at    timestamptz,
  raised_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at    timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, po_number)
);
SELECT hims_util.attach_touch_trigger('purchase_orders');
CREATE INDEX idx_po_open ON purchase_orders (tenant_id, status, expected_on)
  WHERE status IN ('pending_approval','approved','sent','partially_received');

CREATE TABLE purchase_order_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no           integer NOT NULL,
  item_id           uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity_ordered  numeric(12,3) NOT NULL CHECK (quantity_ordered > 0),
  quantity_received numeric(12,3) NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  unit_cost_cents   integer NOT NULL CHECK (unit_cost_cents >= 0),
  tax_rate          numeric(5,4) NOT NULL DEFAULT 0,
  UNIQUE (purchase_order_id, line_no),
  -- Suppliers routinely ship a little over; 10% tolerance avoids blocking goods
  -- receipt on a legitimate delivery while still catching keying errors.
  CONSTRAINT chk_po_line_receipt CHECK (quantity_received <= quantity_ordered * 1.1)
);

-- -----------------------------------------------------------------------------
-- Prescribing and dispensing
-- -----------------------------------------------------------------------------
CREATE TABLE prescriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reference       text NOT NULL,
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  encounter_id    uuid REFERENCES encounters(id) ON DELETE SET NULL,
  prescriber_id   uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','partially_dispensed','dispensed',
                                      'completed','cancelled','expired','on_hold')),
  prescribed_at   timestamptz NOT NULL DEFAULT now(),
  valid_until     date,
  -- Digital signature over the serialised prescription; what makes it legal.
  signature_hash  bytea,
  signed_at       timestamptz,
  -- Interaction/allergy warnings the prescriber was shown and overrode.
  overridden_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  override_reason text,
  notes_encrypted bytea,
  -- Externally fulfilled scripts are tracked but never dispensed here.
  fulfilment      text NOT NULL DEFAULT 'in_house'
                    CHECK (fulfilment IN ('in_house','external_pharmacy','patient_supplied')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
SELECT hims_util.attach_touch_trigger('prescriptions');
CREATE UNIQUE INDEX uq_prescriptions_reference ON prescriptions (tenant_id, reference);
CREATE INDEX idx_prescriptions_patient ON prescriptions (patient_id, prescribed_at DESC);
-- The pharmacy queue.
CREATE INDEX idx_prescriptions_queue ON prescriptions (tenant_id, status, prescribed_at)
  WHERE status IN ('active','partially_dispensed');

CREATE TABLE prescription_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  prescription_id  uuid NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  line_no          integer NOT NULL,
  item_id          uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  -- Snapshot, because a script must read the same a decade later even if the
  -- catalogue entry is retired or renamed.
  medication_name  text NOT NULL,
  strength         text,
  form             text,
  route            text NOT NULL,
  -- Structured sig, so the label printer and the MAR chart agree.
  dose_quantity    numeric(10,3) NOT NULL CHECK (dose_quantity > 0),
  dose_unit        text NOT NULL,
  frequency_code   text NOT NULL,            -- 'BD', 'TDS', 'Q8H', 'PRN'
  frequency_per_day numeric(5,2),
  duration_days    integer CHECK (duration_days IS NULL OR duration_days > 0),
  as_needed        boolean NOT NULL DEFAULT false,
  instructions     text NOT NULL,            -- printed on the label
  quantity_prescribed numeric(12,3) NOT NULL CHECK (quantity_prescribed > 0),
  quantity_dispensed  numeric(12,3) NOT NULL DEFAULT 0 CHECK (quantity_dispensed >= 0),
  refills_authorised smallint NOT NULL DEFAULT 0 CHECK (refills_authorised >= 0),
  refills_used     smallint NOT NULL DEFAULT 0 CHECK (refills_used >= 0),
  substitution_allowed boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','partially_dispensed','dispensed','cancelled')),
  UNIQUE (prescription_id, line_no),
  CONSTRAINT chk_refills CHECK (refills_used <= refills_authorised)
);
CREATE INDEX idx_prescription_items_rx ON prescription_items (prescription_id);

CREATE TABLE dispenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reference       text NOT NULL,
  prescription_id uuid NOT NULL REFERENCES prescriptions(id) ON DELETE RESTRICT,
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  location_id     uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  dispensed_by    uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  -- Second signature, mandatory for controlled drugs.
  checked_by      uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  dispensed_at    timestamptz NOT NULL DEFAULT now(),
  -- Counselling is a dispensing requirement in most jurisdictions.
  counselling_given boolean NOT NULL DEFAULT false,
  invoice_id      uuid REFERENCES invoices(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'completed'
                    CHECK (status IN ('completed','reversed')),
  reversal_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference)
);
CREATE INDEX idx_dispenses_prescription ON dispenses (prescription_id);
CREATE INDEX idx_dispenses_patient ON dispenses (patient_id, dispensed_at DESC);

CREATE TABLE dispense_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dispense_id          uuid NOT NULL REFERENCES dispenses(id) ON DELETE CASCADE,
  prescription_item_id uuid NOT NULL REFERENCES prescription_items(id) ON DELETE RESTRICT,
  item_id              uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  batch_id             uuid REFERENCES stock_batches(id) ON DELETE RESTRICT,
  quantity             numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price_cents     integer NOT NULL DEFAULT 0,
  -- Set when the pharmacist substituted a generic for the brand prescribed.
  substituted_for_item_id uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  substitution_reason  text,
  stock_movement_id    bigint REFERENCES stock_movements(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_dispense_items_dispense ON dispense_items (dispense_id);

-- Medication administration record: what was actually given at the bedside.
CREATE TABLE medication_administrations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id           uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  prescription_item_id uuid REFERENCES prescription_items(id) ON DELETE SET NULL,
  encounter_id         uuid REFERENCES encounters(id) ON DELETE SET NULL,
  item_id              uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  medication_name      text NOT NULL,
  dose_given           numeric(10,3),
  dose_unit            text,
  route                text,
  site                 text,
  scheduled_for        timestamptz,
  administered_at      timestamptz,
  administered_by      uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  witnessed_by         uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('scheduled','given','refused','held','omitted',
                                           'not_available','self_administered')),
  omission_reason      text,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_mar_patient_time ON medication_administrations (patient_id, scheduled_for DESC);
-- The ward's "doses due" board.
CREATE INDEX idx_mar_due ON medication_administrations (tenant_id, scheduled_for)
  WHERE status = 'scheduled';
