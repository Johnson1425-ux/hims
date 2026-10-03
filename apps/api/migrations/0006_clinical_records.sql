-- =============================================================================
-- 0006  Clinical records: encounters, vitals, notes, orders, results
-- -----------------------------------------------------------------------------
-- A signed clinical note is a legal document. The model therefore treats
-- `encounters` as append-only once signed: the row's status moves to 'signed',
-- a trigger blocks further edits to the narrative columns, and any later change
-- is a new `encounter_amendments` row that references the original. This is
-- what makes the record defensible in an audit or a malpractice review.
-- =============================================================================

CREATE TABLE encounters (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reference        text NOT NULL,
  patient_id       uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  appointment_id   uuid REFERENCES appointments(id) ON DELETE SET NULL,
  provider_id      uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  facility_id      uuid REFERENCES facilities(id) ON DELETE SET NULL,
  department_id    uuid REFERENCES departments(id) ON DELETE SET NULL,

  encounter_class  text NOT NULL DEFAULT 'ambulatory'
                     CHECK (encounter_class IN ('ambulatory','emergency','inpatient','virtual','home','observation')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  -- Discharge / disposition once the visit closes.
  disposition      text CHECK (disposition IN ('discharged_home','admitted','referred',
                                               'transferred','left_without_being_seen','deceased')),

  -- ---- SOAP narrative. Clinical free text is PHI-dense -> encrypted. --------
  chief_complaint        text,                -- short, needed for triage boards
  subjective_encrypted   bytea,
  objective_encrypted    bytea,
  assessment_encrypted   bytea,
  plan_encrypted         bytea,
  -- Structured, codeable outputs stay queryable for reporting and claims.
  diagnosis_codes        jsonb NOT NULL DEFAULT '[]'::jsonb,
  procedure_codes        jsonb NOT NULL DEFAULT '[]'::jsonb,
  follow_up_in_days      integer CHECK (follow_up_in_days IS NULL OR follow_up_in_days > 0),

  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','in_progress','pending_signature','signed','amended','voided')),
  -- Attestation. `signature_hash` covers the serialised clinical content, so a
  -- later silent edit is detectable.
  signed_by        uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  signed_at        timestamptz,
  signature_hash   bytea,
  -- Co-signature workflow for residents and students.
  requires_cosign  boolean NOT NULL DEFAULT false,
  cosigned_by      uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  cosigned_at      timestamptz,
  voided_reason    text,

  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_encounter_times CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT chk_encounter_signature
    CHECK ((status IN ('signed','amended')) = (signed_at IS NOT NULL))
);
SELECT hims_util.attach_touch_trigger('encounters');

CREATE UNIQUE INDEX uq_encounters_reference ON encounters (tenant_id, reference);
CREATE INDEX idx_encounters_patient ON encounters (patient_id, started_at DESC);
CREATE INDEX idx_encounters_provider_open ON encounters (provider_id, started_at DESC)
  WHERE status IN ('draft','in_progress','pending_signature');
CREATE INDEX idx_encounters_diagnoses ON encounters USING gin (diagnosis_codes jsonb_path_ops);

ALTER TABLE patient_conditions
  ADD CONSTRAINT fk_condition_encounter
  FOREIGN KEY (recorded_in_encounter_id) REFERENCES encounters(id) ON DELETE SET NULL;

-- Refuse edits to the clinical narrative of a signed encounter. Corrections go
-- through encounter_amendments; this is the database saying "no" to the ORM.
CREATE OR REPLACE FUNCTION hims_util.guard_signed_encounter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('signed','amended','voided') THEN
    IF NEW.subjective_encrypted IS DISTINCT FROM OLD.subjective_encrypted
       OR NEW.objective_encrypted  IS DISTINCT FROM OLD.objective_encrypted
       OR NEW.assessment_encrypted IS DISTINCT FROM OLD.assessment_encrypted
       OR NEW.plan_encrypted       IS DISTINCT FROM OLD.plan_encrypted
       OR NEW.diagnosis_codes      IS DISTINCT FROM OLD.diagnosis_codes
       OR NEW.procedure_codes      IS DISTINCT FROM OLD.procedure_codes
       OR NEW.signed_at            IS DISTINCT FROM OLD.signed_at
       OR NEW.signed_by            IS DISTINCT FROM OLD.signed_by THEN
      RAISE EXCEPTION
        'encounter % is signed; record a formal amendment instead of editing it', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_signed_encounter
  BEFORE UPDATE ON encounters
  FOR EACH ROW EXECUTE FUNCTION hims_util.guard_signed_encounter();

CREATE TABLE encounter_amendments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  encounter_id  uuid NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  sequence_no   integer NOT NULL,
  reason        text NOT NULL,
  -- What changed, as an encrypted narrative plus a structured diff.
  narrative_encrypted bytea,
  changes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  authored_by   uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  signed_at     timestamptz NOT NULL DEFAULT now(),
  signature_hash bytea,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (encounter_id, sequence_no)
);

-- -----------------------------------------------------------------------------
-- Vital signs. Stored in SI units with explicit precision; the UI converts for
-- display. Ranges are sanity bounds, not clinical normals.
-- -----------------------------------------------------------------------------
CREATE TABLE vital_signs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id         uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  encounter_id       uuid REFERENCES encounters(id) ON DELETE SET NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  recorded_by        uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,

  temperature_c      numeric(4,1) CHECK (temperature_c BETWEEN 25 AND 45),
  heart_rate_bpm     integer CHECK (heart_rate_bpm BETWEEN 10 AND 300),
  respiratory_rate   integer CHECK (respiratory_rate BETWEEN 4 AND 80),
  systolic_mmhg      integer CHECK (systolic_mmhg BETWEEN 40 AND 300),
  diastolic_mmhg     integer CHECK (diastolic_mmhg BETWEEN 20 AND 200),
  oxygen_saturation  numeric(4,1) CHECK (oxygen_saturation BETWEEN 50 AND 100),
  blood_glucose_mmol numeric(4,1) CHECK (blood_glucose_mmol BETWEEN 0.5 AND 60),
  weight_kg          numeric(5,2) CHECK (weight_kg BETWEEN 0.3 AND 500),
  height_cm          numeric(5,1) CHECK (height_cm BETWEEN 20 AND 260),
  -- Derived once, here, so every surface shows the same number.
  bmi                numeric(4,1) GENERATED ALWAYS AS (
                       CASE WHEN weight_kg IS NOT NULL AND height_cm IS NOT NULL AND height_cm > 0
                            THEN round(weight_kg / ((height_cm / 100) ^ 2), 1)
                       END
                     ) STORED,
  pain_score         smallint CHECK (pain_score BETWEEN 0 AND 10),
  -- National Early Warning Score, computed by the API from the row above.
  news2_score        smallint CHECK (news2_score BETWEEN 0 AND 20),
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_bp_ordering
    CHECK (systolic_mmhg IS NULL OR diastolic_mmhg IS NULL OR systolic_mmhg > diastolic_mmhg)
);
CREATE INDEX idx_vitals_patient_time ON vital_signs (patient_id, recorded_at DESC);
CREATE INDEX idx_vitals_encounter ON vital_signs (encounter_id);

-- -----------------------------------------------------------------------------
-- Diagnostic orders and results
-- -----------------------------------------------------------------------------
CREATE TABLE diagnostic_catalog (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code          text NOT NULL,
  loinc_code    text,
  name          text NOT NULL,
  category      text NOT NULL DEFAULT 'laboratory'
                  CHECK (category IN ('laboratory','imaging','pathology','cardiology','genetics','point_of_care')),
  specimen_type text,
  turnaround_hours integer,
  price_cents   integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  -- Reference interval template, refined per patient age/sex by the API.
  reference_range jsonb NOT NULL DEFAULT '{}'::jsonb,
  unit          text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT hims_util.attach_touch_trigger('diagnostic_catalog');

CREATE TABLE diagnostic_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reference       text NOT NULL,
  patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  encounter_id    uuid REFERENCES encounters(id) ON DELETE SET NULL,
  ordered_by      uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  catalog_item_id uuid NOT NULL REFERENCES diagnostic_catalog(id) ON DELETE RESTRICT,
  priority        text NOT NULL DEFAULT 'routine'
                    CHECK (priority IN ('routine','urgent','stat')),
  status          text NOT NULL DEFAULT 'ordered'
                    CHECK (status IN ('ordered','collected','in_lab','resulted','verified','cancelled')),
  clinical_notes  text,
  collected_at    timestamptz,
  collected_by    uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  specimen_barcode text,
  resulted_at     timestamptz,
  cancelled_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
SELECT hims_util.attach_touch_trigger('diagnostic_orders');
CREATE UNIQUE INDEX uq_diag_orders_reference ON diagnostic_orders (tenant_id, reference);
CREATE INDEX idx_diag_orders_patient ON diagnostic_orders (patient_id, created_at DESC);
CREATE INDEX idx_diag_orders_worklist ON diagnostic_orders (tenant_id, status, priority, created_at)
  WHERE status IN ('ordered','collected','in_lab');

CREATE TABLE diagnostic_results (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id       uuid NOT NULL REFERENCES diagnostic_orders(id) ON DELETE CASCADE,
  analyte        text NOT NULL,
  loinc_code     text,
  value_numeric  numeric(14,4),
  value_text     text,
  unit           text,
  reference_low  numeric(14,4),
  reference_high numeric(14,4),
  -- Flag drives the red/amber badge on the results board.
  abnormal_flag  text CHECK (abnormal_flag IN ('low','high','critical_low','critical_high','abnormal')),
  -- A critical result must be acknowledged by a clinician; the API escalates
  -- until `acknowledged_at` is set.
  is_critical    boolean NOT NULL DEFAULT false,
  acknowledged_by uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  interpretation_encrypted bytea,
  report_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  verified_by    uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  verified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_results_order ON diagnostic_results (order_id);
CREATE INDEX idx_results_critical ON diagnostic_results (tenant_id, created_at DESC)
  WHERE is_critical AND acknowledged_at IS NULL;

-- -----------------------------------------------------------------------------
-- Referrals and immunisations round out the chart.
-- -----------------------------------------------------------------------------
CREATE TABLE referrals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id       uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  encounter_id     uuid REFERENCES encounters(id) ON DELETE SET NULL,
  referring_provider_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  -- Internal referral resolves to a staff profile; external keeps free text.
  referred_to_provider_id uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  external_provider_name  text,
  external_provider_contact_encrypted bytea,
  specialty        text NOT NULL,
  urgency          text NOT NULL DEFAULT 'routine'
                     CHECK (urgency IN ('routine','urgent','two_week_wait','emergency')),
  reason_encrypted bytea,
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','sent','accepted','declined','completed','expired')),
  sent_at          timestamptz,
  responded_at     timestamptz,
  resulting_appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  valid_until      date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
SELECT hims_util.attach_touch_trigger('referrals');
CREATE INDEX idx_referrals_patient ON referrals (patient_id, created_at DESC);

CREATE TABLE immunisations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id    uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  encounter_id  uuid REFERENCES encounters(id) ON DELETE SET NULL,
  vaccine_code  text NOT NULL,
  vaccine_name  text NOT NULL,
  dose_number   smallint CHECK (dose_number > 0),
  series_total  smallint,
  administered_on date NOT NULL,
  administered_by uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  site          text,
  route         text,
  lot_number    text,
  expiry_date   date,
  manufacturer  text,
  next_dose_due_on date,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_immunisations_patient ON immunisations (patient_id, administered_on DESC);
CREATE INDEX idx_immunisations_due ON immunisations (tenant_id, next_dose_due_on)
  WHERE next_dose_due_on IS NOT NULL;
