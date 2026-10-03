-- Runs once, on first container start, as the POSTGRES_USER (hims_owner).
--
-- Creates the two non-owner roles the application and its support tooling
-- connect as. Migration 0010 creates these too, but only if the migrating user
-- holds CREATEROLE; doing it here means a fresh development stack always has
-- the privilege separation in place.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hims_app') THEN
    -- The API role. No BYPASSRLS: row-level security applies to every query.
    CREATE ROLE hims_app LOGIN PASSWORD 'dev-only-password';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hims_platform') THEN
    -- Cross-tenant support and batch jobs. BYPASSRLS is a deliberate, narrow
    -- grant; everything done with it is audited.
    CREATE ROLE hims_platform LOGIN PASSWORD 'dev-only-password' BYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hims_analytics') THEN
    -- Reads the de-identified reporting views only.
    CREATE ROLE hims_analytics LOGIN PASSWORD 'dev-only-password';
  END IF;
END;
$$;

GRANT CONNECT ON DATABASE hims TO hims_app, hims_platform, hims_analytics;
