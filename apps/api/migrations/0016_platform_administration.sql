-- =============================================================================
-- 0016  Platform administration: the vendor-side realm
-- -----------------------------------------------------------------------------
-- Until now `platform_admin` was a name with nothing behind it: a role row at
-- rank 0 with ZERO entries in the grant matrix, so an account holding it could
-- do strictly less than a receptionist. There was no provisioning path either
-- — the only thing that had ever created a tenant was `pnpm db:seed`.
--
-- This migration builds the realm it needs. The central decision, and the one
-- everything else follows from:
--
--   A PLATFORM OPERATOR IS NOT A USER OF ANY HOSPITAL.
--
-- They get their own table, their own sessions, their own credentials and
-- their own JWT secret. They are never a row in `users`, never a member of a
-- tenant, and no amount of role juggling inside a hospital can produce one —
-- `assertCanGrantRole()` already refuses to mint `platform_admin` from inside
-- a tenant, and that guard is only worth anything if the account genuinely
-- lives somewhere else. This is also why the vendor console cannot be reached
-- by escalating a hospital account: there is no edge between the two graphs.
--
-- The second decision is about the audit trail. Platform actions are written
-- into `audit_events`, the SAME hash-chained, append-only table the clinical
-- path uses, rather than a private log of their own. Two reasons:
--
--   1. A hospital with `audit:read` can then see what the vendor did to their
--      account, which is the property a customer actually wants and the one a
--      separate vendor-only log quietly removes.
--   2. One tamper-evident implementation, not two — the second is always the
--      weaker one.
--
-- `platform_actor_id` is added to that table for attribution, and the chain
-- digest is extended to cover it WITHOUT invalidating a single existing row.
--
-- Wiring that up surfaced a defect in the chain itself, fixed here because
-- the console's audit claims are worthless without it: the trigger's "find
-- the previous row" lookup was subject to RLS, so the chain forked at every
-- tenant boundary and `verify_audit_chain()` could not see past the first
-- one. Worse, run as the migration role it saw no rows at all and reported
-- success. Both are dealt with below.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Operators
-- -----------------------------------------------------------------------------
-- No `tenant_id`, deliberately: this table is outside the tenancy model, so
-- the RLS coverage assertion in 0010 correctly leaves it alone. The access
-- control that replaces RLS here is a GRANT — see the bottom of this file.
CREATE TABLE platform_users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  full_name          text NOT NULL,
  -- NULL until the invitee sets one. An operator account is never created
  -- WITH a password, for the same reason a staff account is not: whoever
  -- typed it could then act as them, and the trail would be unattributable.
  password_hash      text,
  status             text NOT NULL DEFAULT 'invited'
                       CHECK (status IN ('invited','active','suspended')),
  -- The owner flag exists to stop the console being locked out of itself:
  -- the last active owner cannot be suspended or demoted.
  is_owner           boolean NOT NULL DEFAULT false,
  invite_token_hash  bytea,
  invite_expires_at  timestamptz,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- An invited operator has a live token; an active one has a credential.
  CONSTRAINT platform_users_credential_shape CHECK (
    (status = 'invited' AND invite_token_hash IS NOT NULL)
    OR (status <> 'invited' AND password_hash IS NOT NULL)
  )
);
SELECT hims_util.attach_touch_trigger('platform_users');

CREATE UNIQUE INDEX uq_platform_invite_token ON platform_users (invite_token_hash)
  WHERE invite_token_hash IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Sessions
-- -----------------------------------------------------------------------------
-- Mirrors `auth_sessions`, including the rotation lineage: presenting a token
-- that has already been rotated means it was stolen, and the whole family is
-- burned. Kept as a separate table rather than a nullable column on
-- `auth_sessions` so that a bug in the tenant refresh path can never return a
-- platform session, and vice versa.
CREATE TABLE platform_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_user_id   uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  refresh_token_hash bytea NOT NULL UNIQUE,
  -- Shared by a token and all of its successors, so reuse burns the lineage.
  family_id          uuid NOT NULL,
  ip_address         inet,
  user_agent         text,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text
);

CREATE INDEX idx_platform_sessions_user ON platform_sessions (platform_user_id, issued_at DESC);
CREATE INDEX idx_platform_sessions_family ON platform_sessions (family_id);

-- -----------------------------------------------------------------------------
-- Attribution on the shared audit trail
-- -----------------------------------------------------------------------------
-- `actor_user_id` references `users` and therefore cannot hold an operator.
-- `actor_label` already carries a readable name for exactly this reason; this
-- column adds the referential link so "which operator" survives a rename.
ALTER TABLE audit_events
  ADD COLUMN platform_actor_id uuid REFERENCES platform_users(id) ON DELETE SET NULL;

CREATE INDEX idx_audit_platform_actor ON audit_events (platform_actor_id, occurred_at DESC)
  WHERE platform_actor_id IS NOT NULL;

-- Everything the vendor did, newest first, across every tenant.
CREATE INDEX idx_audit_platform_actions ON audit_events (occurred_at DESC)
  WHERE platform_actor_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Fixing the hash chain, which forks at every tenant boundary
-- -----------------------------------------------------------------------------
-- Found while wiring the console up, and it has to be fixed before platform
-- actions can honestly be called tamper-evident.
--
-- THE BUG. `chain_audit_event()` finds the row to chain onto with
--
--     SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1;
--
-- inside a BEFORE INSERT trigger. That SELECT is subject to the same RLS
-- policy as every other read of the table, so it sees only the INSERTING
-- TENANT'S rows. The first event for a new tenant therefore finds nothing,
-- takes `v_prev := NULL`, and writes itself as a second genesis block. Every
-- tenant gets a private chain, and the next row carries on from whichever
-- tail its own policy could see.
--
-- On a two-tenant seed this shows up as exactly one fork. On a real
-- deployment it is one per hospital, and `verify_audit_chain()` reports the
-- first of them and stops — so the trail stops being verifiable at the first
-- tenant boundary rather than at the first tampered row, which is the only
-- thing it was built to detect.
--
-- A platform operator writes events against many tenants, so the console
-- would have forked the chain on essentially every action.
--
-- THE FIX. The tail is kept in a one-row table with no tenant column and no
-- policy, so the lookup returns the same answer whoever is inserting.
-- Cheaper too: a primary-key hit instead of an index scan over a table that
-- grows by millions of rows a month.
--
-- Rewriting the forked history is not on the table. It is append-only by
-- construction and the breaks are evidence of a real defect, not noise to be
-- tidied away. Instead the boundary is RECORDED, and verification runs from
-- it by default.
CREATE TABLE audit_chain_head (
  -- A CHECK'd boolean primary key is the standard way to pin a table to one
  -- row: a second INSERT collides on the key rather than being allowed.
  only_row         boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  last_hash        bytea,
  last_event_id    bigint,
  -- Rows at or below this id were written by the old trigger and may contain
  -- forks. `verify_audit_chain()` starts above it unless told otherwise.
  verified_from_id bigint NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Seeding it has to read `audit_events`, and this migration runs as
-- hims_owner, which FORCE ROW LEVEL SECURITY subjects to the policies too —
-- with no tenant context that is zero rows, and the head would be seeded as
-- if the trail were empty. FORCE is lifted for the two statements that need
-- it and restored immediately; the whole migration is one transaction, so
-- there is no window in which it is observably off.
ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY;

INSERT INTO audit_chain_head (only_row, last_hash, last_event_id, verified_from_id)
SELECT true,
       (SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1),
       (SELECT max(id) FROM audit_events),
       coalesce((SELECT max(id) FROM audit_events), 0);

ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

-- Both roles that write audit rows must be able to move the head with them.
GRANT SELECT, UPDATE ON audit_chain_head TO hims_app, hims_platform;

-- The digest also gains one term, appended ONLY when `platform_actor_id` is
-- not null. For every row written before today, and for every row the
-- clinical path will ever write, that column is NULL, the appended string is
-- empty, and the formula is byte-identical to the one that produced the
-- stored digest — so this change alone invalidates nothing. A platform action
-- now commits to the operator who took it: altering who is recorded as having
-- suspended a hospital breaks the chain from that row on.
CREATE OR REPLACE FUNCTION hims_util.chain_audit_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev bytea;
BEGIN
  -- Still needed. The advisory lock serialises the read-compute-write below
  -- so two concurrent inserts cannot both chain onto the same tail.
  PERFORM pg_advisory_xact_lock(hashtext('hims.audit_chain'));

  SELECT last_hash INTO v_prev FROM audit_chain_head WHERE only_row;

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
    coalesce(NEW.changes::text, '') ||
    CASE WHEN NEW.platform_actor_id IS NULL
         THEN ''
         ELSE '|' || NEW.platform_actor_id::text
    END,
    'sha256'
  );

  -- Rolls back with the row if the transaction fails, so the head can never
  -- advance past an event that was never written.
  UPDATE audit_chain_head
     SET last_hash = NEW.event_hash, last_event_id = NEW.id, updated_at = now()
   WHERE only_row;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hims_util.verify_audit_chain(
  -- NULL means "from the recorded boundary". Pass 0 to walk the forked
  -- history deliberately.
  p_from_id bigint DEFAULT NULL,
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
  v_from   bigint;
  v_head   bigint;
BEGIN
  SELECT coalesce(p_from_id, verified_from_id), last_event_id
    INTO v_from, v_head
    FROM audit_chain_head
   WHERE only_row;

  v_from := coalesce(v_from, 0);

  -- THE VACUOUS PASS, CLOSED. This function reads `audit_events` as the
  -- CALLER, so a role the policies filter — hims_owner with no tenant
  -- context, which is exactly what `pnpm db:verify` connects as — saw zero
  -- rows, walked nothing, returned nothing, and was reported as "audit chain
  -- unbroken". A verifier that cannot fail is worse than no verifier, because
  -- it is believed. If the newest row the head knows about is not visible
  -- here, say so loudly instead.
  IF v_head IS NOT NULL AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id = v_head) THEN
    RAISE EXCEPTION
      'verify_audit_chain cannot see the whole trail: row % is hidden by row-level security. Run it as hims_platform.',
      v_head;
  END IF;

  FOR r IN
    SELECT * FROM audit_events
     WHERE id > v_from
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
      coalesce(r.changes::text, '') ||
      CASE WHEN r.platform_actor_id IS NULL
           THEN ''
           ELSE '|' || r.platform_actor_id::text
      END,
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
-- Tenant lifecycle timestamps
-- -----------------------------------------------------------------------------
-- `tenants.status` has carried 'provisioning | active | suspended | archived'
-- since 0001 and nothing ever moved it off 'active'. The login path already
-- refuses a non-active tenant with TENANT_SUSPENDED, so the column was a
-- working switch with no hand on it. These columns record who moved it and
-- why, which is the first question asked when a hospital cannot sign in.
ALTER TABLE tenants
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN status_reason     text,
  ADD COLUMN provisioned_by    uuid REFERENCES platform_users(id) ON DELETE SET NULL;

CREATE INDEX idx_tenants_status ON tenants (status) WHERE status <> 'active';

-- -----------------------------------------------------------------------------
-- Privileges: this is what stands in for RLS on these tables
-- -----------------------------------------------------------------------------
-- 0010 grants hims_app SELECT/INSERT/UPDATE/DELETE on ALL TABLES, and its
-- default-privileges clause extends that to tables created later — including
-- these. Left alone, the role that serves hospital traffic could read operator
-- password hashes and session tokens. It is revoked explicitly.
--
-- The asymmetry is the point: hims_platform (BYPASSRLS) can reach tenant data,
-- because support work requires it and every such action is audited. hims_app
-- cannot reach the platform realm at all, because nothing a hospital's request
-- legitimately does needs to.
REVOKE ALL ON platform_users, platform_sessions FROM hims_app, hims_analytics;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_users, platform_sessions TO hims_platform;

-- hims_app keeps its existing access to audit_events; the new column rides
-- along with the table grant and holds no secret.

-- -----------------------------------------------------------------------------
-- Guard rail: prove the revoke actually took
-- -----------------------------------------------------------------------------
-- A GRANT that silently did not apply is indistinguishable from one that did,
-- right up until it matters. Fail the migration instead.
DO $$
DECLARE
  v_leak text[];
BEGIN
  SELECT array_agg(DISTINCT table_name)
    INTO v_leak
    FROM information_schema.role_table_grants
   WHERE grantee IN ('hims_app', 'hims_analytics')
     AND table_name IN ('platform_users', 'platform_sessions');

  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION
      'the tenant-facing roles can still reach the platform realm: %',
      array_to_string(v_leak, ', ');
  END IF;
END;
$$;
