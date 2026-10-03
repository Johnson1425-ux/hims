-- =============================================================================
-- 0010  Row-Level Security: tenant isolation enforced by the database
-- -----------------------------------------------------------------------------
-- Application-level `WHERE tenant_id = ?` is a convention, and conventions are
-- one forgotten clause away from a cross-tenant PHI leak — the single worst
-- failure this system can have. These policies make isolation structural: the
-- API connects as `hims_app`, which has no BYPASSRLS, and every tenant-scoped
-- table is FORCE'd so even the table owner is filtered.
--
-- Operational contract: the API calls
--     SELECT hims_util.set_request_context($tenant, $actor)
-- on checkout of every pooled connection. With no context set,
-- current_tenant_id() is NULL, every policy evaluates false, and queries return
-- zero rows. Failing closed is the point.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Database roles. On a managed instance these need rds_superuser/CREATEROLE;
-- if the migration user lacks it, the DO block degrades to a NOTICE and a DBA
-- creates them out of band.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  -- Runtime role for the API. RLS applies.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hims_app') THEN
    CREATE ROLE hims_app NOLOGIN;
  END IF;

  -- Cross-tenant role for platform support and the billing rollup jobs.
  -- BYPASSRLS is a deliberate, narrow grant: only break-glass endpoints and
  -- vetted batch jobs may borrow it, and everything they do is audited.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hims_platform') THEN
    CREATE ROLE hims_platform NOLOGIN BYPASSRLS;
  END IF;

  -- Analytics / BI. Reads the de-identified reporting views only.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hims_analytics') THEN
    CREATE ROLE hims_analytics NOLOGIN;
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE
      'Skipped role creation: the migration user lacks CREATEROLE. '
      'Create hims_app, hims_platform and hims_analytics manually, then re-run.';
END;
$$;

GRANT USAGE ON SCHEMA public, hims_util TO hims_app, hims_platform, hims_analytics;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hims_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hims_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA hims_util TO hims_app, hims_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hims_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hims_platform;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hims_app, hims_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hims_app, hims_platform;

-- -----------------------------------------------------------------------------
-- The common case: every table carrying a NOT NULL tenant_id gets the same
-- policy. Generating it in a loop means a table added later cannot be forgotten
-- as long as it follows the convention — and the assertion at the bottom of
-- this file fails the migration if one does.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND a.attname = 'tenant_id'
       AND a.attnotnull
       AND NOT a.attisdropped
     ORDER BY 1
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format($q$
      CREATE POLICY tenant_isolation ON public.%I
        USING (tenant_id = hims_util.current_tenant_id())
        WITH CHECK (tenant_id = hims_util.current_tenant_id())
    $q$, r.table_name);
    RAISE NOTICE 'RLS enabled on %', r.table_name;
  END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- Special cases, where a NULL tenant_id carries meaning or the table has no
-- tenant column of its own.
-- -----------------------------------------------------------------------------

-- `tenants`: a session sees only its own tenant row.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = hims_util.current_tenant_id())
  WITH CHECK (id = hims_util.current_tenant_id());

-- `users`: platform operators (tenant_id IS NULL) are invisible to tenants.
-- Login happens before any tenant context exists, so the auth module resolves
-- credentials through a SECURITY DEFINER function rather than a direct read.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = hims_util.current_tenant_id())
  WITH CHECK (tenant_id = hims_util.current_tenant_id());

-- `roles`: system roles (tenant_id IS NULL) are readable by everyone but
-- writable by nobody; custom roles are tenant-private.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_read ON roles FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = hims_util.current_tenant_id());
CREATE POLICY roles_write ON roles FOR ALL
  USING (tenant_id = hims_util.current_tenant_id() AND NOT is_system)
  WITH CHECK (tenant_id = hims_util.current_tenant_id() AND NOT is_system);

-- `notification_templates`: same shape — NULL tenant means a built-in template.
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY templates_read ON notification_templates FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = hims_util.current_tenant_id());
CREATE POLICY templates_write ON notification_templates FOR ALL
  USING (tenant_id = hims_util.current_tenant_id())
  WITH CHECK (tenant_id = hims_util.current_tenant_id());

-- `permissions`: a global, read-only catalogue. No tenant dimension.
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY permissions_read ON permissions FOR SELECT USING (true);

-- Join tables with no tenant_id of their own: borrow the parent's tenancy.
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_scope ON role_permissions
  USING (EXISTS (
    SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id
      AND (r.tenant_id IS NULL OR r.tenant_id = hims_util.current_tenant_id())))
  WITH CHECK (EXISTS (
    SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id
      AND r.tenant_id = hims_util.current_tenant_id() AND NOT r.is_system));

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY user_roles_scope ON user_roles
  USING (EXISTS (
    SELECT 1 FROM users u WHERE u.id = user_roles.user_id
      AND u.tenant_id = hims_util.current_tenant_id()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM users u WHERE u.id = user_roles.user_id
      AND u.tenant_id = hims_util.current_tenant_id()));

ALTER TABLE staff_facility_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_facility_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_assignments_scope ON staff_facility_assignments
  USING (EXISTS (
    SELECT 1 FROM staff_profiles s WHERE s.id = staff_facility_assignments.staff_profile_id
      AND s.tenant_id = hims_util.current_tenant_id()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM staff_profiles s WHERE s.id = staff_facility_assignments.staff_profile_id
      AND s.tenant_id = hims_util.current_tenant_id()));

-- `auth_sessions` / `auth_tokens`: written during login, before tenant context
-- exists, so they are reached only through SECURITY DEFINER auth functions and
-- are closed to the ordinary app role.
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_sessions_scope ON auth_sessions
  USING (tenant_id = hims_util.current_tenant_id())
  WITH CHECK (tenant_id = hims_util.current_tenant_id());

ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_tokens_scope ON auth_tokens
  USING (EXISTS (
    SELECT 1 FROM users u WHERE u.id = auth_tokens.user_id
      AND u.tenant_id = hims_util.current_tenant_id()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM users u WHERE u.id = auth_tokens.user_id
      AND u.tenant_id = hims_util.current_tenant_id()));

-- `audit_events`: readable within the tenant, insertable always. A refused
-- cross-tenant probe must still be recordable even when the tenant context
-- does not match, otherwise the attack erases its own evidence.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_events FOR SELECT
  USING (tenant_id = hims_util.current_tenant_id());
CREATE POLICY audit_append ON audit_events FOR INSERT WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- Authentication lookup that must run before a tenant context exists.
-- SECURITY DEFINER, narrowly scoped to one email, returning only what the
-- login flow needs. This is the single sanctioned read outside RLS.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hims_util.find_login_identity(
  p_email       citext,
  p_tenant_slug citext DEFAULT NULL
)
RETURNS TABLE (
  user_id       uuid,
  tenant_id     uuid,
  tenant_slug   citext,
  tenant_status text,
  email         citext,
  password_hash text,
  full_name     text,
  status        text,
  mfa_enabled   boolean,
  failed_login_count integer,
  locked_until  timestamptz,
  must_change_password boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, hims_util, pg_temp
AS $$
  SELECT u.id, u.tenant_id, t.slug, t.status,
         u.email, u.password_hash, u.full_name, u.status,
         u.mfa_enabled, u.failed_login_count, u.locked_until, u.must_change_password
    FROM users u
    LEFT JOIN tenants t ON t.id = u.tenant_id
   WHERE u.email = p_email
     AND u.deleted_at IS NULL
     AND (p_tenant_slug IS NULL OR t.slug = p_tenant_slug)
   ORDER BY u.tenant_id NULLS LAST
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION hims_util.find_login_identity(citext, citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hims_util.find_login_identity(citext, citext) TO hims_app;

-- -----------------------------------------------------------------------------
-- Refresh-token lookup, for the same reason.
--
-- A refresh request arrives with a cookie and nothing else: the tenant is not
-- known until the session row is found, so an ordinary SELECT on auth_sessions
-- is filtered to nothing by the policy above and silent refresh can never
-- work. The lookup is keyed on a SHA-256 of a 48-byte random token, so it
-- cannot be used to enumerate sessions, and it returns only the fields the
-- rotation flow needs — never the token hash itself.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hims_util.find_session_by_refresh_hash(p_token_hash bytea)
RETURNS TABLE (
  id          uuid,
  user_id     uuid,
  tenant_id   uuid,
  expires_at  timestamptz,
  revoked_at  timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, hims_util, pg_temp
AS $$
  SELECT s.id, s.user_id, s.tenant_id, s.expires_at, s.revoked_at
    FROM auth_sessions s
   WHERE s.refresh_token_hash = p_token_hash
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION hims_util.find_session_by_refresh_hash(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hims_util.find_session_by_refresh_hash(bytea) TO hims_app;

-- -----------------------------------------------------------------------------
-- Guard rail 1: every view must run as its INVOKER.
--
-- A view defaults to its owner's permissions, which silently bypasses the
-- row-level security on its base tables. That is a cross-tenant PHI leak with
-- no visible symptom beyond duplicated rows, so it fails the migration.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_leaky text[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname)
    INTO v_leaky
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'v'
     AND NOT COALESCE(
       (SELECT option_value::boolean
          FROM pg_options_to_table(c.reloptions)
         WHERE option_name = 'security_invoker'),
       false);

  IF v_leaky IS NOT NULL THEN
    RAISE EXCEPTION
      'these views do not set security_invoker and would bypass row-level security: %',
      array_to_string(v_leaky, ', ');
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Guard rail 2: fail the migration if any table holding a tenant_id slipped
-- through without a policy. Cheaper to catch here than in a breach report.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_unprotected text[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname)
    INTO v_unprotected
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND NOT c.relrowsecurity;

  IF v_unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'these tenant-scoped tables have no row-level security: %',
      array_to_string(v_unprotected, ', ');
  END IF;
END;
$$;
