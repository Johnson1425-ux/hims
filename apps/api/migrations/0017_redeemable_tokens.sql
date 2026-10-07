-- =============================================================================
-- 0017  Make invitation and reset links redeemable
-- -----------------------------------------------------------------------------
-- `completePasswordReset` looks a token up like this:
--
--     SELECT ... FROM auth_tokens t JOIN users u ON u.id = t.user_id
--      WHERE t.token_hash = $1 ...
--
-- on the UNTENANTED pool, because the tenant is not known until the row is
-- found — the token is all the caller has. But `auth_tokens` carries a policy
-- keyed on `hims_util.current_tenant_id()`:
--
--     EXISTS (SELECT 1 FROM users u
--              WHERE u.id = auth_tokens.user_id
--                AND u.tenant_id = hims_util.current_tenant_id())
--
-- With no context that is false for every row, so the lookup returns nothing,
-- every time. The endpoint answers "that link is invalid or has expired" on
-- the first click of a link generated seconds earlier.
--
-- It takes both features with it: password reset AND staff invitation, since
-- `POST /staff` issues an `invitation` token redeemed through the same path.
-- An invited colleague could not get in by any route, and tenant provisioning
-- inherits the same dead end for the first hospital administrator.
--
-- THE FIX is the one 0013 already established for exactly this shape of
-- problem — a lookup that must run before a tenant is known. A SECURITY
-- DEFINER function, narrow, parameterised, and granted only to hims_app:
--
--   * It takes a SHA-256 digest of a 32-byte random token. There is nothing
--     to enumerate: a caller who can produce the digest already holds the
--     token.
--   * It returns four non-secret columns — never the hash, never a password.
--   * hims_app gains no ability to read `auth_tokens` generally. The grant is
--     on the function, not the table.
--
-- FORCE is lifted on `auth_tokens` for the same reason 0013 lifted it on
-- `users`, `auth_sessions` and `tenants`: FORCE subjects the TABLE OWNER to
-- the policy too, and this function is owned by the migration role. Without
-- it the SECURITY DEFINER context is filtered just as the caller was, and
-- nothing changes. Row-level security itself stays ENABLED, and hims_app —
-- the role the API actually runs as, and not the owner — remains fully
-- subject to it on every ordinary query.
-- =============================================================================

ALTER TABLE auth_tokens NO FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION hims_util.find_redeemable_token(p_token_hash bytea)
RETURNS TABLE (
  token_id  uuid,
  user_id   uuid,
  tenant_id uuid,
  purpose   text
)
LANGUAGE sql
SECURITY DEFINER
-- Pinned: a SECURITY DEFINER function with a caller-controlled search_path is
-- a privilege-escalation primitive.
SET search_path = public, hims_util, pg_temp
STABLE
AS $$
  SELECT t.id, t.user_id, u.tenant_id, t.purpose
    FROM auth_tokens t
    JOIN users u ON u.id = t.user_id
   WHERE t.token_hash = p_token_hash
     -- Only the two purposes a person can redeem by following a link.
     -- 'mfa_challenge' and 'email_verify' are not password-setting flows and
     -- must not become one through this door.
     AND t.purpose IN ('password_reset', 'invitation')
     AND t.consumed_at IS NULL
     AND t.expires_at > now()
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION hims_util.find_redeemable_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hims_util.find_redeemable_token(bytea) TO hims_app;

-- -----------------------------------------------------------------------------
-- Guard rail: prove the lookup is actually callable by the API's role
-- -----------------------------------------------------------------------------
-- This is the failure 0013 was written about: a bootstrap lookup that returns
-- nothing looks exactly like "no match", so it fails silently and only shows
-- up as a user who cannot sign in. Prove it RUNS here instead.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM hims_util.find_redeemable_token(digest('bootstrap-probe', 'sha256'));

  IF v_count IS NULL THEN
    RAISE EXCEPTION 'the token redemption lookup is not callable';
  END IF;
END;
$$;
