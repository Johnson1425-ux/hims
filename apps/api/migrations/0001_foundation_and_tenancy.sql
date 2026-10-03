-- =============================================================================
-- 0001  Foundation: extensions, shared helpers, tenant registry
-- -----------------------------------------------------------------------------
-- Multi-tenancy model: SHARED SCHEMA + tenant_id discriminator + PostgreSQL
-- Row-Level Security. Every tenant-scoped table carries `tenant_id` and is
-- protected by a FORCE'd RLS policy keyed on the `hims.tenant_id` session GUC,
-- which the API sets once per request/transaction. A query that forgets its
-- WHERE clause therefore returns zero rows instead of another hospital's chart.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";    -- gen_random_uuid(), digest(), hmac()
CREATE EXTENSION IF NOT EXISTS "citext";      -- case-insensitive email/codes
CREATE EXTENSION IF NOT EXISTS "btree_gist";  -- EXCLUDE constraints on ranges
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- fuzzy name search

CREATE SCHEMA IF NOT EXISTS hims_util;

-- -----------------------------------------------------------------------------
-- Session context helpers
-- -----------------------------------------------------------------------------
-- The API calls `SELECT hims_util.set_request_context($1, $2)` as the first
-- statement of the transaction that serves a request. Reads below are NULL-safe
-- so that migrations and maintenance jobs (which run as the owner, outside RLS)
-- still work.

CREATE OR REPLACE FUNCTION hims_util.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('hims.tenant_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION hims_util.current_actor_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('hims.actor_id', true), '')::uuid;
$$;

-- SCOPE MATTERS, and getting it wrong is a cross-tenant leak:
--
--   p_local = true  (default) -> the setting is reset when the transaction ends.
--     This is the only safe scope behind a transaction-pooling proxy such as
--     PgBouncer, where the physical connection is handed to a different tenant's
--     request the moment this transaction commits. Every request path therefore
--     opens a transaction, sets context, does its work, and commits.
--
--   p_local = false -> the setting survives for the whole session. Used only by
--     single-tenant background workers that own their connection outright
--     (nightly rollups, the reminder dispatcher), never by the request path.
--
-- If nothing is set, current_tenant_id() returns NULL, every RLS policy
-- evaluates false, and queries return nothing. Failing closed is deliberate.
CREATE OR REPLACE FUNCTION hims_util.set_request_context(
  p_tenant_id uuid,
  p_actor_id  uuid DEFAULT NULL,
  p_local     boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('hims.tenant_id', COALESCE(p_tenant_id::text, ''), p_local);
  PERFORM set_config('hims.actor_id',  COALESCE(p_actor_id::text, ''),  p_local);
END;
$$;

-- Belt and braces for the worker path: drop any inherited context explicitly.
CREATE OR REPLACE FUNCTION hims_util.clear_request_context()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('hims.tenant_id', '', false);
  PERFORM set_config('hims.actor_id',  '', false);
END;
$$;

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hims_util.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Convenience: attach the updated_at trigger to a table in one call.
CREATE OR REPLACE FUNCTION hims_util.attach_touch_trigger(p_table regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON %s
       FOR EACH ROW EXECUTE FUNCTION hims_util.touch_updated_at()', p_table);
END;
$$;

-- -----------------------------------------------------------------------------
-- Tenants (hospitals / clinic groups). NOT tenant-scoped itself.
-- -----------------------------------------------------------------------------
CREATE TABLE tenants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               citext NOT NULL UNIQUE,
  legal_name         text   NOT NULL,
  display_name       text   NOT NULL,
  -- Short code woven into human-facing identifiers (MRN-MGH-000042).
  facility_code      text   NOT NULL UNIQUE CHECK (facility_code ~ '^[A-Z0-9]{2,8}$'),
  timezone           text   NOT NULL DEFAULT 'UTC',
  locale             text   NOT NULL DEFAULT 'en-US',
  currency           char(3) NOT NULL DEFAULT 'USD',
  -- Per-tenant data encryption key, itself encrypted under the KMS master key
  -- (envelope encryption). The plaintext DEK never lands in this column.
  dek_wrapped        bytea  NOT NULL,
  dek_key_version    integer NOT NULL DEFAULT 1,
  subscription_tier  text   NOT NULL DEFAULT 'standard'
                       CHECK (subscription_tier IN ('trial','standard','enterprise')),
  status             text   NOT NULL DEFAULT 'active'
                       CHECK (status IN ('provisioning','active','suspended','archived')),
  settings           jsonb  NOT NULL DEFAULT '{}'::jsonb,
  branding           jsonb  NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
SELECT hims_util.attach_touch_trigger('tenants');

-- Monotonic, gap-tolerant per-tenant counters for MRNs, invoice numbers, etc.
CREATE TABLE tenant_sequences (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_key text NOT NULL,
  last_value   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, sequence_key)
);

CREATE OR REPLACE FUNCTION hims_util.next_in_sequence(
  p_tenant_id uuid,
  p_key       text
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_next bigint;
BEGIN
  INSERT INTO tenant_sequences (tenant_id, sequence_key, last_value)
  VALUES (p_tenant_id, p_key, 1)
  ON CONFLICT (tenant_id, sequence_key)
  DO UPDATE SET last_value = tenant_sequences.last_value + 1
  RETURNING last_value INTO v_next;

  RETURN v_next;
END;
$$;

-- Physical sites belonging to a tenant (main hospital, satellite clinic, lab).
CREATE TABLE facilities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  code         text NOT NULL,
  kind         text NOT NULL DEFAULT 'hospital'
                 CHECK (kind IN ('hospital','clinic','lab','pharmacy','imaging')),
  address_line1 text,
  address_line2 text,
  city         text,
  region       text,
  postal_code  text,
  country      char(2) NOT NULL DEFAULT 'US',
  phone        text,
  timezone     text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT hims_util.attach_touch_trigger('facilities');
CREATE INDEX idx_facilities_tenant ON facilities (tenant_id) WHERE is_active;

-- Clinical departments (Cardiology, Radiology, ...) used for routing and rota.
CREATE TABLE departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id uuid REFERENCES facilities(id) ON DELETE SET NULL,
  name        text NOT NULL,
  code        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT hims_util.attach_touch_trigger('departments');
CREATE INDEX idx_departments_tenant ON departments (tenant_id);
