-- =============================================================================
-- 0011  Index every cascading foreign key
-- -----------------------------------------------------------------------------
-- PostgreSQL indexes the REFERENCED side of a foreign key automatically (it has
-- to, to enforce uniqueness) but never the REFERENCING side. Two consequences
-- bite a system like this one:
--
--   1. Every RLS policy here filters on `tenant_id`. Without a leading index on
--      it, each policy check degrades to a sequential scan — on `audit_events`
--      and `stock_movements` that is tens of millions of rows per query.
--   2. ON DELETE CASCADE / RESTRICT makes the database verify children on every
--      parent delete. Archiving one tenant would sequentially scan ~60 tables.
--
-- Rather than hand-maintain the list, this migration derives it: any
-- single-column FK with CASCADE or RESTRICT semantics that has no index with
-- that column in the leading position gets one. Re-running is a no-op, so the
-- same block can be replayed after new tables are added.
--
-- The write cost is a few extra B-tree entries per INSERT. The alternative is a
-- sequential scan on the largest tables in the schema, so the trade is easy.
-- =============================================================================

DO $$
DECLARE
  r          record;
  v_index    text;
  v_created  integer := 0;
BEGIN
  FOR r IN
    SELECT con.conrelid::regclass::text AS table_name,
           a.attname                    AS column_name,
           con.conname                  AS constraint_name
      FROM pg_constraint con
      JOIN pg_attribute a
        ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     WHERE con.contype = 'f'
       AND con.connamespace = 'public'::regnamespace
       AND array_length(con.conkey, 1) = 1
       -- CASCADE ('c') and RESTRICT ('r') force a child lookup on parent delete.
       AND con.confdeltype IN ('c','r')
       AND NOT EXISTS (
         SELECT 1 FROM pg_index i
          WHERE i.indrelid = con.conrelid
            AND i.indkey[0] = con.conkey[1])
     ORDER BY 1, 2
  LOOP
    -- Deterministic, collision-free, and under the 63-byte identifier limit.
    v_index := left(format('idx_fk_%s_%s', r.table_name, r.column_name), 63);

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (%I)',
                   v_index, r.table_name, r.column_name);
    v_created := v_created + 1;
  END LOOP;

  RAISE NOTICE 'created % foreign-key index(es)', v_created;
END;
$$;

-- Composite indexes for the access patterns the single-column indexes above do
-- not serve well. These are the queries on the hot path of each module, so they
-- are declared explicitly rather than derived.

-- "Today's clinic list for this facility", the receptionist's home screen.
CREATE INDEX IF NOT EXISTS idx_appointments_desk_queue
  ON appointments (tenant_id, facility_id, starts_at)
  WHERE status IN ('scheduled','confirmed','checked_in');

-- "Charts I am responsible for", the clinician's home screen.
CREATE INDEX IF NOT EXISTS idx_encounters_tenant_provider
  ON encounters (tenant_id, provider_id, started_at DESC);

-- Accounts-receivable ageing, bucketed by payer.
CREATE INDEX IF NOT EXISTS idx_invoices_ar_ageing
  ON invoices (tenant_id, primary_policy_id, due_on)
  WHERE balance_cents > 0 AND status IN ('issued','partially_paid','overdue');

-- Pharmacy stock board: one row per item/location, filtered by tenant.
CREATE INDEX IF NOT EXISTS idx_stock_levels_lookup
  ON stock_levels (tenant_id, location_id, item_id);

-- Controlled-drug register extract: a legal report, run by date range.
CREATE INDEX IF NOT EXISTS idx_movements_controlled_register
  ON stock_movements (tenant_id, item_id, occurred_at DESC)
  WHERE movement_type IN ('dispense','administer','wastage','adjustment');

-- The §164.528 accounting-of-disclosures report.
CREATE INDEX IF NOT EXISTS idx_audit_patient_phi
  ON audit_events (patient_id, occurred_at DESC)
  WHERE touched_phi;

ANALYZE;
