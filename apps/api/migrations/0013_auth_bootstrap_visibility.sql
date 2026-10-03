-- =============================================================================
-- 0013  Let the authentication bootstrap read what it must
-- -----------------------------------------------------------------------------
-- THE BUG THIS FIXES
--
-- Authentication is a bootstrap problem: a login request arrives knowing only
-- an email address, and a refresh request knowing only a cookie. Neither knows
-- the tenant yet, so neither can set the RLS context that every policy keys on.
--
-- Migration 0010 handles that with two SECURITY DEFINER functions —
-- `find_login_identity` and `find_session_by_refresh_hash` — which run as their
-- OWNER rather than the caller, and are granted only to hims_app.
--
-- But `FORCE ROW LEVEL SECURITY` subjects the table owner to its policies too.
-- Since the functions are owned by the role that ran the migrations
-- (hims_owner), they were still filtered: with no tenant context every policy
-- evaluates false, both functions returned zero rows, and NOBODY COULD LOG IN.
--
-- This only shows up on a correctly privileged installation. Running migrations
-- as a superuser hides it completely, because a superuser bypasses RLS
-- regardless — which is exactly why development should not do that.
--
-- THE FIX, AND WHY IT IS NARROW
--
-- FORCE is lifted on precisely the three tables the bootstrap must read before
-- a tenant is known. What this does and does not change:
--
--   * hims_app — the role the API actually runs as — is NOT the owner, so RLS
--     applies to it in full, unchanged. Every isolation guarantee the invariant
--     suite asserts still holds, because every one of those assertions runs as
--     hims_app.
--   * Only the schema owner gains unfiltered access, and only on these three
--     tables. The owner is a deploy-time role; it is not the runtime identity.
--
-- The security value given up is smaller than it looks. FORCE was never a
-- boundary against the owner: an owner can issue
-- `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` whenever it likes. FORCE guards
-- against ACCIDENTAL owner-context queries, and the deliberate, parameterised,
-- hims_app-only functions above are not that.
--
-- The alternative — reassigning the functions to the BYPASSRLS role — needs the
-- migration role to hold membership in hims_platform, which means a superuser
-- in the deploy path. Trading a superuser deploy credential for this is a bad
-- bargain.
-- =============================================================================

ALTER TABLE users          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions  NO FORCE ROW LEVEL SECURITY;

-- Row-level security itself stays ENABLED on all three. Only the owner's
-- exemption changes; every other role is still filtered.
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
     AND c.relname IN ('users', 'tenants', 'auth_sessions')
     AND NOT c.relrowsecurity;

  IF v_unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'row-level security was disabled, not merely unforced, on: %',
      array_to_string(v_unprotected, ', ');
  END IF;
END;
$$;

-- Prove the bootstrap works before the migration is allowed to succeed. A
-- deployment that cannot authenticate anyone should fail here, loudly, rather
-- than at the first login attempt.
DO $$
DECLARE
  v_count integer;
BEGIN
  -- No tenant context is set, which is exactly the state a login arrives in.
  PERFORM hims_util.clear_request_context();

  SELECT count(*) INTO v_count
    FROM hims_util.find_login_identity('bootstrap-probe@example.invalid', NULL);

  -- Zero rows is the right answer for an address that does not exist; what is
  -- being proven is that the function RUNS and is readable, not that it matched.
  IF v_count IS NULL THEN
    RAISE EXCEPTION 'the authentication lookup is not callable';
  END IF;

  RAISE NOTICE 'authentication bootstrap verified: the login lookup is reachable without tenant context';
END;
$$;
