-- =============================================================================
-- 0004  Patients, insurance, intake forms, consent and documents
-- -----------------------------------------------------------------------------
-- ENCRYPTION POLICY (see docs/04-security-and-hipaa.md for the full rationale)
--
--   Tier 1 — application-layer AES-256-GCM, per-tenant data key:
--       national identifiers (SSN), phone, email, street address,
--       insurance member numbers, emergency-contact details, free-text notes
--       attached to intake answers.
--     Columns are `bytea` and named `*_encrypted`. The server cannot sort or
--     range-scan them; exact lookup goes through the matching `*_blind_index`
--     column, an HMAC-SHA256 of the normalised value under a separate index key.
--
--   Tier 2 — plaintext column, protected by RLS + at-rest volume encryption
--            + mandatory access audit:
--       names, date of birth, sex, clinical codes and observations.
--     These must remain searchable and sortable for patient safety: a clinician
--     has to be able to find "Okafor, b. 1974-03" under time pressure, and age
--     drives weight-based dosing. Encrypting them would push that work into the
--     application tier and make duplicate detection unreliable.
-- =============================================================================

CREATE TABLE patients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Medical Record Number: the identifier staff speak out loud.
  mrn                 text NOT NULL,
  -- Patient-portal login, if they have activated one.
  user_id             uuid REFERENCES users(id) ON DELETE SET NULL,

  -- ---- Tier 2 demographics (plaintext, RLS-protected) ----------------------
  given_name          text NOT NULL,
  middle_name         text,
  family_name         text NOT NULL,
  preferred_name      text,
  full_name           text GENERATED ALWAYS AS (given_name || ' ' || family_name) STORED,
  date_of_birth       date NOT NULL,
  sex_at_birth        text NOT NULL CHECK (sex_at_birth IN ('female','male','intersex','unknown')),
  gender_identity     text,
  pronouns            text,
  marital_status      text CHECK (marital_status IN ('single','married','partnered','divorced','widowed','unknown')),
  blood_type          text CHECK (blood_type IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown')),
  preferred_language  text NOT NULL DEFAULT 'en',
  requires_interpreter boolean NOT NULL DEFAULT false,
  nationality         char(2),

  -- ---- Tier 1 direct identifiers (AES-256-GCM + blind index) ---------------
  national_id_encrypted      bytea,
  national_id_blind_index    bytea,
  phone_encrypted            bytea,
  phone_blind_index          bytea,
  alt_phone_encrypted        bytea,
  email_encrypted            bytea,
  email_blind_index          bytea,
  address_encrypted          bytea,   -- JSON blob: line1, line2, city, region, postal
  -- Postal district kept in the clear for catchment-area reporting; too coarse
  -- to re-identify on its own, and the reporting layer needs to GROUP BY it.
  address_region             text,
  emergency_contact_encrypted bytea,  -- JSON blob: name, relationship, phone

  -- ---- Care relationships --------------------------------------------------
  primary_provider_id uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  registered_facility_id uuid REFERENCES facilities(id) ON DELETE SET NULL,
  registered_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  registration_source text NOT NULL DEFAULT 'front_desk'
                        CHECK (registration_source IN ('front_desk','portal','import','referral','emergency')),

  -- ---- Lifecycle -----------------------------------------------------------
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','inactive','deceased','merged','archived')),
  deceased_on         date,
  -- Set when this record loses a merge; points at the surviving chart.
  merged_into_id      uuid REFERENCES patients(id) ON DELETE SET NULL,
  vip_flag            boolean NOT NULL DEFAULT false,
  -- Opt-out of the provider directory / research reuse (HIPAA §164.522).
  restrictions        jsonb NOT NULL DEFAULT '{}'::jsonb,
  photo_url           text,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,

  CONSTRAINT chk_patient_dob_sane
    CHECK (date_of_birth > DATE '1875-01-01' AND date_of_birth <= CURRENT_DATE),
  CONSTRAINT chk_patient_deceased
    CHECK ((status = 'deceased') = (deceased_on IS NOT NULL)),
  CONSTRAINT chk_patient_merge
    CHECK ((status = 'merged') = (merged_into_id IS NOT NULL))
);
SELECT hims_util.attach_touch_trigger('patients');

CREATE UNIQUE INDEX uq_patients_mrn ON patients (tenant_id, mrn);
CREATE UNIQUE INDEX uq_patients_portal_user ON patients (user_id) WHERE user_id IS NOT NULL;
-- Blind-index lookups: "is this person already registered?" without decrypting.
CREATE INDEX idx_patients_national_id_bi ON patients (tenant_id, national_id_blind_index)
  WHERE national_id_blind_index IS NOT NULL;
CREATE INDEX idx_patients_phone_bi ON patients (tenant_id, phone_blind_index)
  WHERE phone_blind_index IS NOT NULL;
CREATE INDEX idx_patients_email_bi ON patients (tenant_id, email_blind_index)
  WHERE email_blind_index IS NOT NULL;
-- Typeahead search across the active roster.
CREATE INDEX idx_patients_name_trgm ON patients USING gin (full_name gin_trgm_ops);
CREATE INDEX idx_patients_dob ON patients (tenant_id, date_of_birth);
CREATE INDEX idx_patients_active ON patients (tenant_id, family_name, given_name)
  WHERE deleted_at IS NULL AND status = 'active';
-- Duplicate-candidate detection on registration.
CREATE INDEX idx_patients_dupe_probe ON patients (tenant_id, family_name, date_of_birth, sex_at_birth);

-- Assign the next MRN for a tenant, e.g. MRN-MGH-000042.
CREATE OR REPLACE FUNCTION hims_util.allocate_mrn(p_tenant_id uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_code text;
  v_seq  bigint;
BEGIN
  SELECT facility_code INTO v_code FROM tenants WHERE id = p_tenant_id;
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'unknown tenant %', p_tenant_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  v_seq := hims_util.next_in_sequence(p_tenant_id, 'mrn');
  RETURN format('MRN-%s-%s', v_code, lpad(v_seq::text, 6, '0'));
END;
$$;

-- -----------------------------------------------------------------------------
-- Allergies and the problem list: read on every prescribing decision, so they
-- live on dedicated tables rather than inside a JSON chart blob.
-- -----------------------------------------------------------------------------
CREATE TABLE patient_allergies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id    uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  allergen      text NOT NULL,
  allergen_kind text NOT NULL DEFAULT 'medication'
                  CHECK (allergen_kind IN ('medication','food','environmental','latex','contrast','other')),
  -- Links to the catalogue when the allergen is a stocked drug, enabling a hard
  -- interaction block at prescribing time.
  medication_id uuid,            -- FK added in 0008 once medications exists
  reaction      text,
  severity      text NOT NULL DEFAULT 'moderate'
                  CHECK (severity IN ('mild','moderate','severe','anaphylaxis')),
  onset_on      date,
  is_active     boolean NOT NULL DEFAULT true,
  recorded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
SELECT hims_util.attach_touch_trigger('patient_allergies');
CREATE INDEX idx_allergies_patient ON patient_allergies (patient_id) WHERE is_active;

CREATE TABLE patient_conditions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id     uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  -- ICD-10-CM, or SNOMED CT for problems without a billable code.
  code_system    text NOT NULL DEFAULT 'ICD10' CHECK (code_system IN ('ICD10','SNOMED','LOCAL')),
  code           text NOT NULL,
  display        text NOT NULL,
  category       text NOT NULL DEFAULT 'problem'
                   CHECK (category IN ('problem','diagnosis','family_history','social_history','surgical_history')),
  clinical_status text NOT NULL DEFAULT 'active'
                   CHECK (clinical_status IN ('active','recurrence','remission','resolved')),
  severity       text CHECK (severity IN ('mild','moderate','severe')),
  onset_on       date,
  resolved_on    date,
  -- The encounter where this problem was first captured.
  recorded_in_encounter_id uuid,   -- FK added in 0006
  recorded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
SELECT hims_util.attach_touch_trigger('patient_conditions');
CREATE INDEX idx_conditions_patient ON patient_conditions (patient_id, clinical_status);
CREATE INDEX idx_conditions_code ON patient_conditions (tenant_id, code_system, code);

-- -----------------------------------------------------------------------------
-- Insurance
-- -----------------------------------------------------------------------------
CREATE TABLE insurance_payers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  code            text NOT NULL,
  payer_type      text NOT NULL DEFAULT 'commercial'
                    CHECK (payer_type IN ('commercial','medicare','medicaid','self_pay','workers_comp','government','ngo')),
  -- X12 270/271 eligibility and 837 claim endpoints.
  eligibility_endpoint text,
  claims_endpoint text,
  electronic_payer_id text,
  contact_phone   text,
  contact_email   text,
  -- Average days from submission to remittance; drives the AR ageing forecast.
  typical_settlement_days integer NOT NULL DEFAULT 30,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT hims_util.attach_touch_trigger('insurance_payers');

CREATE TABLE patient_insurance_policies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id         uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  payer_id           uuid NOT NULL REFERENCES insurance_payers(id) ON DELETE RESTRICT,
  -- Coordination of benefits: 1 = primary, 2 = secondary, 3 = tertiary.
  precedence         smallint NOT NULL DEFAULT 1 CHECK (precedence BETWEEN 1 AND 3),
  plan_name          text,
  group_number       text,
  member_number_encrypted   bytea NOT NULL,
  member_number_blind_index bytea NOT NULL,
  -- Last four digits, in the clear, so the front desk can confirm a card
  -- over the phone without a decrypt round-trip.
  member_number_last4 char(4),
  subscriber_relationship text NOT NULL DEFAULT 'self'
                       CHECK (subscriber_relationship IN ('self','spouse','child','other')),
  subscriber_name_encrypted bytea,
  subscriber_dob     date,
  effective_on       date NOT NULL,
  expires_on         date,
  -- Benefit design, in cents to avoid float drift.
  copay_cents        integer CHECK (copay_cents IS NULL OR copay_cents >= 0),
  coinsurance_rate   numeric(5,4) CHECK (coinsurance_rate IS NULL OR coinsurance_rate BETWEEN 0 AND 1),
  deductible_cents   integer CHECK (deductible_cents IS NULL OR deductible_cents >= 0),
  deductible_met_cents integer NOT NULL DEFAULT 0,
  out_of_pocket_max_cents integer,
  -- Eligibility check results (X12 271 response summary).
  verification_status text NOT NULL DEFAULT 'unverified'
                       CHECK (verification_status IN ('unverified','pending','active','inactive','error')),
  verified_at        timestamptz,
  verified_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  verification_payload jsonb,
  card_front_document_id uuid,     -- FK added below
  card_back_document_id  uuid,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_policy_window CHECK (expires_on IS NULL OR expires_on >= effective_on)
);
SELECT hims_util.attach_touch_trigger('patient_insurance_policies');
-- One active policy per precedence level per patient; this also serves as the
-- lookup index for "fetch this patient's coverage in billing order".
CREATE UNIQUE INDEX uq_policy_precedence
  ON patient_insurance_policies (patient_id, precedence) WHERE is_active;
CREATE INDEX idx_policies_member_bi ON patient_insurance_policies (tenant_id, member_number_blind_index);

-- -----------------------------------------------------------------------------
-- Documents: object-storage pointers. Bytes live in S3 with SSE-KMS; this table
-- holds only metadata plus the per-object key wrap, never the file itself.
-- -----------------------------------------------------------------------------
CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id      uuid REFERENCES patients(id) ON DELETE CASCADE,
  staff_profile_id uuid REFERENCES staff_profiles(id) ON DELETE CASCADE,
  kind            text NOT NULL
                    CHECK (kind IN ('insurance_card','identity_proof','lab_report','imaging',
                                    'referral','discharge_summary','consent_form','intake_form',
                                    'credential','invoice','other')),
  title           text NOT NULL,
  storage_bucket  text NOT NULL,
  storage_key     text NOT NULL,
  content_type    text NOT NULL,
  byte_size       bigint NOT NULL CHECK (byte_size > 0),
  -- SHA-256 of the plaintext, for integrity verification on download.
  content_sha256  bytea NOT NULL,
  encryption_key_wrapped bytea,
  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Documents can be retracted but never hard-deleted while a retention hold
  -- applies; the purge job honours `retain_until`.
  retain_until    date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (storage_bucket, storage_key)
);
CREATE INDEX idx_documents_patient ON documents (patient_id, kind) WHERE deleted_at IS NULL;

ALTER TABLE staff_credentials
  ADD CONSTRAINT fk_staff_credentials_document
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE patient_insurance_policies
  ADD CONSTRAINT fk_policy_card_front
  FOREIGN KEY (card_front_document_id) REFERENCES documents(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_policy_card_back
  FOREIGN KEY (card_back_document_id) REFERENCES documents(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- Digital intake forms: tenant-authored questionnaires, versioned so that a
-- submitted answer set always resolves against the schema it was captured on.
-- -----------------------------------------------------------------------------
CREATE TABLE form_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  title       text NOT NULL,
  description text,
  category    text NOT NULL DEFAULT 'intake'
                CHECK (category IN ('intake','consent','screening','discharge','satisfaction','pre_op')),
  -- JSON Schema-shaped field definitions; rendered dynamically by the frontend.
  schema      jsonb NOT NULL,
  -- Fields whose answers must be encrypted at rest before storage.
  phi_fields  text[] NOT NULL DEFAULT '{}',
  is_published boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key, version)
);
SELECT hims_util.attach_touch_trigger('form_templates');

CREATE TABLE form_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id   uuid NOT NULL REFERENCES form_templates(id) ON DELETE RESTRICT,
  patient_id    uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id uuid,              -- FK added in 0005
  -- Non-sensitive answers queryable as JSON; PHI answers in the bytea blob.
  answers       jsonb NOT NULL DEFAULT '{}'::jsonb,
  answers_encrypted bytea,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','submitted','reviewed','superseded')),
  submitted_at  timestamptz,
  submitted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
SELECT hims_util.attach_touch_trigger('form_submissions');
CREATE INDEX idx_submissions_patient ON form_submissions (patient_id, status);

-- -----------------------------------------------------------------------------
-- Consent: the legal basis for every disclosure. Append-only by convention —
-- a withdrawal is a new row, never an UPDATE of the original grant.
-- -----------------------------------------------------------------------------
CREATE TABLE patient_consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id    uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  consent_type  text NOT NULL
                  CHECK (consent_type IN ('treatment','privacy_notice','data_sharing','telehealth',
                                          'research','marketing','financial_responsibility')),
  granted       boolean NOT NULL,
  scope         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Captured signature image plus the method used to verify identity.
  signature_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  signed_by_relationship text NOT NULL DEFAULT 'self'
                  CHECK (signed_by_relationship IN ('self','guardian','power_of_attorney','next_of_kin')),
  signed_by_name text,
  witnessed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  ip_address    inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_consents_patient ON patient_consents (patient_id, consent_type, effective_from DESC);
