-- =============================================================================
-- 0003  Staff and provider profiles
-- -----------------------------------------------------------------------------
-- `users` answers "can this person log in?". `staff_profiles` answers
-- "what are they licensed to do, and where do they work?". Keeping them apart
-- lets a locum doctor exist as a bookable provider before their account is
-- activated, and lets an account be deactivated without erasing the clinical
-- attribution on notes they signed.
-- =============================================================================

CREATE TABLE staff_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Human-facing staff number, e.g. STF-MGH-000017.
  staff_number        text NOT NULL,
  title               text,                       -- Dr., RN, PharmD
  given_name          text NOT NULL,
  family_name         text NOT NULL,
  display_name        text GENERATED ALWAYS AS (
                        btrim(coalesce(title,'') || ' ' || given_name || ' ' || family_name)
                      ) STORED,
  employment_type     text NOT NULL DEFAULT 'permanent'
                        CHECK (employment_type IN ('permanent','contract','locum','resident','volunteer')),
  primary_department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  primary_facility_id uuid REFERENCES facilities(id) ON DELETE SET NULL,
  -- Clinician-only fields; NULL for administrative staff.
  is_provider         boolean NOT NULL DEFAULT false,
  specialties         text[] NOT NULL DEFAULT '{}',
  license_number_encrypted bytea,
  license_authority   text,
  license_expires_on  date,
  npi_number          text,                        -- US National Provider Identifier
  dea_number_encrypted bytea,                      -- required to prescribe controlled drugs
  -- Default slot length in minutes used when generating availability.
  default_slot_minutes integer NOT NULL DEFAULT 20
                        CHECK (default_slot_minutes BETWEEN 5 AND 240),
  consultation_fee_cents integer NOT NULL DEFAULT 0 CHECK (consultation_fee_cents >= 0),
  accepts_new_patients boolean NOT NULL DEFAULT true,
  bio                 text,
  hired_on            date,
  terminated_on       date,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_staff_employment_window
    CHECK (terminated_on IS NULL OR hired_on IS NULL OR terminated_on >= hired_on)
);
SELECT hims_util.attach_touch_trigger('staff_profiles');

CREATE UNIQUE INDEX uq_staff_number ON staff_profiles (tenant_id, staff_number);
CREATE UNIQUE INDEX uq_staff_user   ON staff_profiles (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_staff_providers ON staff_profiles (tenant_id, primary_department_id)
  WHERE is_provider AND is_active;
CREATE INDEX idx_staff_name_trgm ON staff_profiles USING gin (display_name gin_trgm_ops);

-- Staff may legitimately work across several sites; this is the assignment map
-- that scheduling and facility-scoped RBAC both read from.
CREATE TABLE staff_facility_assignments (
  staff_profile_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  facility_id      uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  department_id    uuid REFERENCES departments(id) ON DELETE SET NULL,
  is_primary       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (staff_profile_id, facility_id)
);

-- Licence and certification documents, with expiry tracking so the compliance
-- dashboard can warn before a clinician's credential lapses.
CREATE TABLE staff_credentials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_profile_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  kind             text NOT NULL
                     CHECK (kind IN ('medical_license','board_certification','dea_registration',
                                     'bls_acls','malpractice_insurance','immunisation','background_check')),
  label            text NOT NULL,
  issuing_body     text,
  reference_encrypted bytea,
  issued_on        date,
  expires_on       date,
  document_id      uuid,          -- FK added in 0004 once documents exists
  verified_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
SELECT hims_util.attach_touch_trigger('staff_credentials');
CREATE INDEX idx_staff_credentials_expiry
  ON staff_credentials (tenant_id, expires_on) WHERE expires_on IS NOT NULL;
