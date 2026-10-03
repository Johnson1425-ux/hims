-- =============================================================================
-- 0005  Appointment scheduling
-- -----------------------------------------------------------------------------
-- The integrity rule that matters here cannot live in application code: two
-- concurrent booking requests that both pass an availability check will both
-- commit. This schema pushes the rule into PostgreSQL as a GiST EXCLUDE
-- constraint over (provider, time range), so the second transaction fails with
-- a unique-violation the API translates into HTTP 409. The optimistic path in
-- the API is then just "insert and handle 23P01".
-- =============================================================================

-- Service catalogue: what can be booked, how long it takes, what it costs.
CREATE TABLE appointment_types (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  department_id     uuid REFERENCES departments(id) ON DELETE SET NULL,
  code              text NOT NULL,
  name              text NOT NULL,
  description       text,
  duration_minutes  integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  -- Minutes of protected time after the visit for documentation / room turnover.
  buffer_after_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),
  modality          text NOT NULL DEFAULT 'in_person'
                      CHECK (modality IN ('in_person','telehealth','home_visit','phone')),
  -- Can a patient book this themselves from the portal?
  patient_bookable  boolean NOT NULL DEFAULT true,
  requires_referral boolean NOT NULL DEFAULT false,
  -- How far ahead a patient may self-book, and the cut-off for self-service.
  min_notice_hours  integer NOT NULL DEFAULT 2 CHECK (min_notice_hours >= 0),
  max_advance_days  integer NOT NULL DEFAULT 180 CHECK (max_advance_days > 0),
  base_price_cents  integer NOT NULL DEFAULT 0 CHECK (base_price_cents >= 0),
  -- Service code billed when this appointment is invoiced.
  default_service_item_id uuid,     -- FK added in 0007
  colour            text NOT NULL DEFAULT '#0F6FFF'
                      CHECK (colour ~ '^#[0-9A-Fa-f]{6}$'),
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT hims_util.attach_touch_trigger('appointment_types');

-- Recurring weekly working pattern per provider per facility.
CREATE TABLE provider_availability (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_profile_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  facility_id      uuid REFERENCES facilities(id) ON DELETE CASCADE,
  -- ISO-8601: 1 = Monday .. 7 = Sunday.
  day_of_week      smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  -- Local wall-clock time, interpreted in the facility's timezone. Storing
  -- `time` rather than timestamptz is what makes the rule survive a DST shift.
  start_time       time NOT NULL,
  end_time         time NOT NULL,
  slot_minutes     integer NOT NULL DEFAULT 20 CHECK (slot_minutes BETWEEN 5 AND 240),
  -- Cap on concurrent bookings in one slot (group clinics, double-booked rota).
  capacity         smallint NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  availability_kind text NOT NULL DEFAULT 'clinic'
                      CHECK (availability_kind IN ('clinic','telehealth','surgery','on_call','admin')),
  effective_from   date NOT NULL DEFAULT CURRENT_DATE,
  effective_until  date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_availability_times CHECK (end_time > start_time),
  CONSTRAINT chk_availability_window
    CHECK (effective_until IS NULL OR effective_until >= effective_from)
);
SELECT hims_util.attach_touch_trigger('provider_availability');
CREATE INDEX idx_availability_provider
  ON provider_availability (staff_profile_id, day_of_week);

-- One-off overrides: leave, conference, theatre list, extra clinic.
CREATE TABLE availability_exceptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_profile_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  period           tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  -- 'unavailable' subtracts from the weekly pattern; 'extra' adds to it.
  effect           text NOT NULL DEFAULT 'unavailable'
                     CHECK (effect IN ('unavailable','extra')),
  reason           text NOT NULL DEFAULT 'leave'
                     CHECK (reason IN ('leave','sick','training','conference','surgery','public_holiday','other')),
  notes            text,
  approved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_exception_times CHECK (ends_at > starts_at)
);
CREATE INDEX idx_exceptions_provider_period
  ON availability_exceptions USING gist (staff_profile_id, period);

-- -----------------------------------------------------------------------------
-- Appointments
-- -----------------------------------------------------------------------------
CREATE TABLE appointments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reference          text NOT NULL,          -- APT-MGH-000913, quoted to patients
  patient_id         uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  provider_id        uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  appointment_type_id uuid NOT NULL REFERENCES appointment_types(id) ON DELETE RESTRICT,
  facility_id        uuid REFERENCES facilities(id) ON DELETE SET NULL,
  department_id      uuid REFERENCES departments(id) ON DELETE SET NULL,
  room               text,

  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  -- Materialised range powering both the overlap constraint and calendar reads.
  slot               tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,

  status             text NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled','confirmed','checked_in','in_progress',
                                         'completed','cancelled','no_show','rescheduled')),
  modality           text NOT NULL DEFAULT 'in_person'
                       CHECK (modality IN ('in_person','telehealth','home_visit','phone')),
  priority           text NOT NULL DEFAULT 'routine'
                       CHECK (priority IN ('routine','urgent','emergency','follow_up')),
  booking_channel    text NOT NULL DEFAULT 'front_desk'
                       CHECK (booking_channel IN ('front_desk','portal','phone','walk_in','referral','recall')),

  reason_for_visit   text,
  -- Patient-authored complaint text can be sensitive; encrypt the free field.
  patient_notes_encrypted bytea,
  internal_notes     text,

  -- Front-desk workflow timestamps; the gaps between them are the wait-time KPI.
  confirmed_at       timestamptz,
  checked_in_at      timestamptz,
  started_at         timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  cancellation_reason text,
  cancelled_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Set on the old row when a booking is moved, so the trail stays intact.
  rescheduled_to_id  uuid REFERENCES appointments(id) ON DELETE SET NULL,

  telehealth_join_url text,
  booked_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_appointment_times CHECK (ends_at > starts_at),
  CONSTRAINT chk_appointment_cancelled
    CHECK ((status IN ('cancelled','no_show')) OR cancelled_at IS NULL),

  -- The real guard rail: a provider cannot hold two live bookings that overlap.
  -- Cancelled, no-show and rescheduled rows drop out of the constraint so the
  -- freed slot is immediately rebookable.
  CONSTRAINT excl_provider_double_booking
    EXCLUDE USING gist (provider_id WITH =, slot WITH &&)
    WHERE (status IN ('scheduled','confirmed','checked_in','in_progress'))
);
SELECT hims_util.attach_touch_trigger('appointments');

CREATE UNIQUE INDEX uq_appointments_reference ON appointments (tenant_id, reference);
-- Day-view and provider-calendar reads.
CREATE INDEX idx_appointments_provider_day ON appointments (provider_id, starts_at);
CREATE INDEX idx_appointments_patient ON appointments (patient_id, starts_at DESC);
CREATE INDEX idx_appointments_tenant_window ON appointments (tenant_id, starts_at)
  WHERE status IN ('scheduled','confirmed','checked_in','in_progress');
CREATE INDEX idx_appointments_facility_day ON appointments (facility_id, starts_at);

ALTER TABLE form_submissions
  ADD CONSTRAINT fk_submission_appointment
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL;

-- Patients waiting for an earlier slot; the cancellation hook scans this table
-- and offers the freed slot in priority order.
CREATE TABLE appointment_waitlist (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id          uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_type_id uuid NOT NULL REFERENCES appointment_types(id) ON DELETE CASCADE,
  preferred_provider_id uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  facility_id         uuid REFERENCES facilities(id) ON DELETE SET NULL,
  earliest_date       date NOT NULL DEFAULT CURRENT_DATE,
  latest_date         date,
  -- Bitmask-free representation of acceptable weekdays and time bands.
  preferred_days      smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
  preferred_time_band text NOT NULL DEFAULT 'any'
                        CHECK (preferred_time_band IN ('any','morning','afternoon','evening')),
  priority            smallint NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 9),
  status              text NOT NULL DEFAULT 'waiting'
                        CHECK (status IN ('waiting','offered','booked','expired','withdrawn')),
  offered_at          timestamptz,
  offer_expires_at    timestamptz,
  resulting_appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
SELECT hims_util.attach_touch_trigger('appointment_waitlist');
CREATE INDEX idx_waitlist_open
  ON appointment_waitlist (tenant_id, appointment_type_id, priority, created_at)
  WHERE status = 'waiting';

-- Planned reminder sends. One row per (appointment, channel, offset) so a
-- reschedule can cancel the pending rows and re-plan without duplicate texts.
CREATE TABLE appointment_reminders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  channel        text NOT NULL CHECK (channel IN ('email','sms','push','voice')),
  -- Hours before `starts_at` that this reminder fires (48, 24, 2 ...).
  offset_hours   integer NOT NULL CHECK (offset_hours >= 0),
  scheduled_for  timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sent','failed','skipped','cancelled')),
  sent_at        timestamptz,
  failure_reason text,
  attempts       smallint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, channel, offset_hours)
);
-- The reminder worker's only query: due and still pending.
CREATE INDEX idx_reminders_due ON appointment_reminders (scheduled_for)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION hims_util.allocate_reference(
  p_tenant_id uuid,
  p_key       text,
  p_prefix    text
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_code text;
  v_seq  bigint;
BEGIN
  SELECT facility_code INTO v_code FROM tenants WHERE id = p_tenant_id;
  v_seq := hims_util.next_in_sequence(p_tenant_id, p_key);
  RETURN format('%s-%s-%s', p_prefix, v_code, lpad(v_seq::text, 6, '0'));
END;
$$;
