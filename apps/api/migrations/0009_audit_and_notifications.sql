-- =============================================================================
-- 0009  Audit trail, break-glass access, notification outbox
-- -----------------------------------------------------------------------------
-- HIPAA §164.312(b) requires a record of activity in systems holding ePHI, and
-- §164.308(a)(1)(ii)(D) requires that it be reviewed. Two design choices make
-- this trail worth having:
--
--   1. It records READS, not only writes. "Who opened this chart and why" is
--      the question an investigation actually asks.
--   2. It is HASH-CHAINED. Each row commits to the previous row's digest, so
--      deleting or editing history breaks verification. A trigger blocks
--      UPDATE and DELETE outright; the chain is what detects a DBA who bypasses
--      the trigger with table ownership.
-- =============================================================================

CREATE TABLE audit_events (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid REFERENCES tenants(id) ON DELETE RESTRICT,
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- ---- Actor ---------------------------------------------------------------
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role      text,
  -- Denormalised so the trail stays readable after an account is deleted.
  actor_label     text,
  on_behalf_of_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  impersonated    boolean NOT NULL DEFAULT false,

  -- ---- Action --------------------------------------------------------------
  action          text NOT NULL,          -- 'patient.read', 'prescription.sign'
  outcome         text NOT NULL DEFAULT 'success'
                    CHECK (outcome IN ('success','denied','error')),
  -- Denied attempts are the interesting half of an audit trail.
  denial_reason   text,

  -- ---- Target --------------------------------------------------------------
  resource_type   text NOT NULL,
  resource_id     uuid,
  -- The patient whose PHI was touched, whatever the resource type. This single
  -- column is what makes the §164.528 "accounting of disclosures" report a
  -- one-line query instead of a union across twenty tables.
  patient_id      uuid REFERENCES patients(id) ON DELETE SET NULL,
  touched_phi     boolean NOT NULL DEFAULT false,

  -- ---- Context -------------------------------------------------------------
  http_method     text,
  http_path       text,
  http_status     integer,
  request_id      uuid,
  session_id      uuid,
  ip_address      inet,
  user_agent      text,
  -- Field-level before/after for writes. PHI values are redacted to field
  -- names only; the audit log must not become a second unencrypted copy.
  changes         jsonb,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- ---- Tamper evidence -----------------------------------------------------
  prev_hash       bytea,
  event_hash      bytea NOT NULL
);

-- Partitioning note: at hospital volume this table grows by millions of rows a
-- month. In production, declare it PARTITION BY RANGE (occurred_at) monthly and
-- detach partitions to cold storage after the retention window. It is left
-- unpartitioned here so the schema stays readable.
CREATE INDEX idx_audit_tenant_time ON audit_events (tenant_id, occurred_at DESC);
CREATE INDEX idx_audit_actor ON audit_events (actor_user_id, occurred_at DESC);
-- The disclosure-accounting query.
CREATE INDEX idx_audit_patient ON audit_events (patient_id, occurred_at DESC)
  WHERE patient_id IS NOT NULL;
CREATE INDEX idx_audit_resource ON audit_events (resource_type, resource_id);
-- Security review: everything refused, newest first.
CREATE INDEX idx_audit_denied ON audit_events (tenant_id, occurred_at DESC)
  WHERE outcome = 'denied';

-- Compute the chain link inside the database, so the hash cannot be forged by
-- a buggy or malicious application deploy.
CREATE OR REPLACE FUNCTION hims_util.chain_audit_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev bytea;
BEGIN
  -- Two concurrent inserts would otherwise read the same tail row and both
  -- commit with an identical prev_hash, forking the chain. A transaction-scoped
  -- advisory lock serialises just the link computation. Audit writes are small
  -- and off the critical path, so the contention cost is acceptable; the
  -- alternative is a chain that cannot be verified.
  PERFORM pg_advisory_xact_lock(hashtext('hims.audit_chain'));

  SELECT event_hash INTO v_prev
    FROM audit_events
   ORDER BY id DESC
   LIMIT 1;

  NEW.prev_hash := v_prev;
  NEW.event_hash := digest(
    coalesce(encode(v_prev, 'hex'), 'genesis') || '|' ||
    coalesce(NEW.tenant_id::text, '') || '|' ||
    NEW.occurred_at::text || '|' ||
    coalesce(NEW.actor_user_id::text, '') || '|' ||
    NEW.action || '|' ||
    NEW.outcome || '|' ||
    NEW.resource_type || '|' ||
    coalesce(NEW.resource_id::text, '') || '|' ||
    coalesce(NEW.patient_id::text, '') || '|' ||
    coalesce(NEW.changes::text, ''),
    'sha256'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_chain_audit_event
  BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION hims_util.chain_audit_event();

CREATE TRIGGER trg_audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION hims_util.reject_ledger_mutation();

-- Walk the chain and report the first row whose digest does not reconcile.
-- Run nightly; a non-empty result is a security incident.
CREATE OR REPLACE FUNCTION hims_util.verify_audit_chain(
  p_from_id bigint DEFAULT 0,
  p_limit   bigint DEFAULT 1000000
)
RETURNS TABLE (broken_at_id bigint, expected bytea, found bytea)
LANGUAGE plpgsql
AS $$
DECLARE
  r        record;
  v_prev   bytea;
  v_expect bytea;
  v_first  boolean := true;
BEGIN
  FOR r IN
    SELECT * FROM audit_events
     WHERE id > p_from_id
     ORDER BY id
     LIMIT p_limit
  LOOP
    IF v_first THEN
      v_prev  := r.prev_hash;
      v_first := false;
    END IF;

    v_expect := digest(
      coalesce(encode(v_prev, 'hex'), 'genesis') || '|' ||
      coalesce(r.tenant_id::text, '') || '|' ||
      r.occurred_at::text || '|' ||
      coalesce(r.actor_user_id::text, '') || '|' ||
      r.action || '|' ||
      r.outcome || '|' ||
      r.resource_type || '|' ||
      coalesce(r.resource_id::text, '') || '|' ||
      coalesce(r.patient_id::text, '') || '|' ||
      coalesce(r.changes::text, ''),
      'sha256'
    );

    IF v_expect <> r.event_hash THEN
      RETURN QUERY SELECT r.id, v_expect, r.event_hash;
      RETURN;
    END IF;

    v_prev := r.event_hash;
  END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- Break-glass: emergency access to a chart outside a care relationship.
-- Granted instantly (a patient is in front of the clinician), then reviewed.
-- -----------------------------------------------------------------------------
CREATE TABLE break_glass_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_id    uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  justification text NOT NULL CHECK (length(btrim(justification)) >= 20),
  -- Short by design: typically one shift.
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Mandatory retrospective review by the privacy officer.
  reviewed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  review_outcome text CHECK (review_outcome IN ('appropriate','questionable','violation')),
  review_notes  text
);
CREATE INDEX idx_break_glass_active ON break_glass_grants (user_id, patient_id, expires_at);
CREATE INDEX idx_break_glass_unreviewed ON break_glass_grants (tenant_id, created_at)
  WHERE reviewed_at IS NULL;

-- -----------------------------------------------------------------------------
-- Care-team membership: the positive side of minimum-necessary access. A
-- clinician reaching a chart with no row here and no break-glass grant is
-- logged as 'denied'.
-- -----------------------------------------------------------------------------
CREATE TABLE care_team_members (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id       uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  staff_profile_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  relationship     text NOT NULL DEFAULT 'treating'
                     CHECK (relationship IN ('primary','treating','consulting','covering','nursing','pharmacy')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  added_by         uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX uq_care_team_active
  ON care_team_members (patient_id, staff_profile_id, relationship)
  WHERE ended_at IS NULL;
CREATE INDEX idx_care_team_staff ON care_team_members (staff_profile_id) WHERE ended_at IS NULL;

-- -----------------------------------------------------------------------------
-- Notification outbox. The API writes rows in the same transaction as the
-- business change; a worker drains them. That is what keeps "appointment
-- booked" and "confirmation sent" from diverging when the SMS gateway is down.
-- -----------------------------------------------------------------------------
CREATE TABLE notification_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('email','sms','push','voice','in_app')),
  locale      text NOT NULL DEFAULT 'en',
  subject     text,
  -- Handlebars-style body. Templates must never interpolate PHI into an SMS;
  -- `phi_safe` is enforced by the renderer.
  body        text NOT NULL,
  phi_safe    boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key, channel, locale)
);
SELECT hims_util.attach_touch_trigger('notification_templates');

CREATE TABLE notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Recipient: a user, or an unregistered contact for appointment reminders.
  user_id        uuid REFERENCES users(id) ON DELETE CASCADE,
  patient_id     uuid REFERENCES patients(id) ON DELETE CASCADE,
  channel        text NOT NULL CHECK (channel IN ('email','sms','push','voice','in_app')),
  template_key   text,
  -- Destination is PHI-adjacent (a phone number identifies a person), so it is
  -- encrypted at rest and only decrypted inside the sending worker.
  destination_encrypted bytea,
  subject        text,
  body           text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  category       text NOT NULL DEFAULT 'operational'
                   CHECK (category IN ('appointment','clinical','billing','inventory',
                                       'security','operational','marketing')),
  priority       smallint NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 9),
  status         text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','sending','sent','delivered','failed','bounced','cancelled','suppressed')),
  scheduled_for  timestamptz NOT NULL DEFAULT now(),
  attempts       smallint NOT NULL DEFAULT 0,
  max_attempts   smallint NOT NULL DEFAULT 5,
  next_attempt_at timestamptz,
  sent_at        timestamptz,
  delivered_at   timestamptz,
  failure_reason text,
  provider       text,
  provider_message_id text,
  -- Idempotency: a retried booking must not send a second confirmation.
  dedupe_key     text,
  related_kind   text,
  related_id     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
SELECT hims_util.attach_touch_trigger('notifications');
CREATE UNIQUE INDEX uq_notifications_dedupe ON notifications (tenant_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
-- The worker's claim query.
CREATE INDEX idx_notifications_due ON notifications (scheduled_for, priority)
  WHERE status = 'queued';
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_retry ON notifications (next_attempt_at)
  WHERE status = 'failed';

-- Per-person channel consent. TCPA and HIPAA both bite here: an SMS reminder
-- to a withdrawn number is a violation, not just a nuisance.
CREATE TABLE notification_preferences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id  uuid REFERENCES patients(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  category    text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('email','sms','push','voice','in_app')),
  enabled     boolean NOT NULL DEFAULT true,
  -- Quiet hours in the recipient's local time.
  quiet_from  time,
  quiet_until time,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_pref_subject CHECK (patient_id IS NOT NULL OR user_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_pref_patient ON notification_preferences (patient_id, category, channel)
  WHERE patient_id IS NOT NULL;
CREATE UNIQUE INDEX uq_pref_user ON notification_preferences (user_id, category, channel)
  WHERE user_id IS NOT NULL;

-- NOTE: `schema_migrations` is created by the runner in src/db/migrate.ts before
-- the first migration executes, so it is deliberately not declared here.
