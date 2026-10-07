-- =============================================================================
-- 0020  Say what actually happens when an operator is deleted
-- -----------------------------------------------------------------------------
-- 0016 gave `audit_events.platform_actor_id` an ON DELETE SET NULL, which
-- reads as "removing an operator anonymises their history". It does not.
-- `audit_events` carries an append-only trigger that refuses UPDATE, so the
-- cascade the constraint promises is the one thing the table forbids, and a
-- DELETE fails with:
--
--   audit_events is append-only (attempted update); post a compensating entry
--
-- which names neither operators nor the foreign key, and leaves whoever ran
-- it guessing.
--
-- RESTRICT states the real rule. An operator who has done anything audited
-- cannot be removed — their attribution is part of a tamper-evident record —
-- and one who has done nothing still can. The failure is then an ordinary
-- foreign-key violation naming this constraint, which is a lead rather than
-- a riddle.
--
-- Nothing is lost. The console has never offered deletion, only suspension,
-- which ends their sessions immediately and keeps the trail intact; and
-- `actor_label` already carries the operator's email so a row stays readable
-- whatever happens to the account.
--
-- The same reasoning does NOT apply to `tenants.provisioned_by` or
-- `subscription_invoices.issued_by`: those are ordinary mutable tables where
-- nulling the reference is both possible and the right answer, and the
-- invoice keeps its own record of who issued it in the audit trail.
-- =============================================================================

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_platform_actor_id_fkey,
  ADD CONSTRAINT audit_events_platform_actor_id_fkey
    FOREIGN KEY (platform_actor_id) REFERENCES platform_users(id) ON DELETE RESTRICT;

-- Prove it took, and prove the rule it encodes: an operator with audit
-- history must be refused, and the refusal must be the FK rather than the
-- append-only trigger.
DO $$
DECLARE
  v_action text;
BEGIN
  SELECT confdeltype INTO v_action
    FROM pg_constraint
   WHERE conname = 'audit_events_platform_actor_id_fkey';

  -- 'r' = RESTRICT. 'n' would mean SET NULL survived.
  IF v_action IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION
      'audit_events.platform_actor_id still has delete action %, expected RESTRICT', v_action;
  END IF;
END;
$$;
