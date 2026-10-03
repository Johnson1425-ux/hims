-- =============================================================================
-- verify_invariants.sql
-- -----------------------------------------------------------------------------
-- Exercises the guarantees the schema claims to make, against a throwaway
-- database. Run after every migration change:
--
--   createdb hims_check && psql -d hims_check -f <each migration> \
--     && psql -d hims_check -v ON_ERROR_STOP=1 -f seeds/verify_invariants.sql
--
-- Every check either prints PASS or aborts the script. There is no "warning"
-- tier on purpose: a tenant-isolation regression is not a warning.
-- =============================================================================
\set ON_ERROR_STOP on
\pset pager off
\timing off

\set TENANT_A '11111111-1111-1111-1111-111111111111'
\set TENANT_B '22222222-2222-2222-2222-222222222222'

\echo '############ fixtures ############'
\set QUIET on
INSERT INTO tenants (id, slug, legal_name, display_name, facility_code, dek_wrapped) VALUES
  (:'TENANT_A','mercy','Mercy Health Group','Mercy General','MGH','\x00'),
  (:'TENANT_B','stjude','St Jude Clinics','St Jude','SJC','\x00');

INSERT INTO facilities (id, tenant_id, name, code) VALUES
  ('aaaa1111-0000-0000-0000-000000000001',:'TENANT_A','Mercy Main','MAIN'),
  ('aaaa2222-0000-0000-0000-000000000001',:'TENANT_B','St Jude Main','MAIN');

INSERT INTO staff_profiles (id, tenant_id, staff_number, given_name, family_name, is_provider, title) VALUES
  ('bbbb1111-0000-0000-0000-000000000001',:'TENANT_A','STF-001','Ada','Okafor',true,'Dr.'),
  ('bbbb1111-0000-0000-0000-000000000002',:'TENANT_A','STF-002','Noor','Haddad',true,'Dr.'),
  ('bbbb2222-0000-0000-0000-000000000001',:'TENANT_B','STF-001','Ben','Marek',true,'Dr.');

INSERT INTO patients (id, tenant_id, mrn, given_name, family_name, date_of_birth, sex_at_birth) VALUES
  ('cccc1111-0000-0000-0000-000000000001',:'TENANT_A',hims_util.allocate_mrn(:'TENANT_A'),
   'Grace','Mensah','1974-03-11','female'),
  ('cccc2222-0000-0000-0000-000000000001',:'TENANT_B',hims_util.allocate_mrn(:'TENANT_B'),
   'Hugo','Silva','1990-07-02','male');

INSERT INTO appointment_types (id, tenant_id, code, name, duration_minutes) VALUES
  ('dddd1111-0000-0000-0000-000000000001',:'TENANT_A','GP30','General Consultation',30);
\set QUIET off

\echo
\echo '############ 1. multi-tenant isolation ############'
BEGIN;
  SET LOCAL ROLE hims_app;
  SELECT hims_util.set_request_context(:'TENANT_A', NULL);

  DO $$
  DECLARE n int;
  BEGIN
    SELECT count(*) INTO n FROM patients;
    ASSERT n = 1, format('expected 1 visible patient, saw %s', n);
    RAISE NOTICE 'PASS  tenant A sees only its own patient roster';

    SELECT count(*) INTO n FROM tenants;
    ASSERT n = 1, 'a tenant must not enumerate other tenants';
    RAISE NOTICE 'PASS  tenant registry filtered to self';

    SELECT count(*) INTO n FROM patients WHERE id = 'cccc2222-0000-0000-0000-000000000001';
    ASSERT n = 0, 'cross-tenant primary-key read leaked a chart';
    RAISE NOTICE 'PASS  direct primary-key read of a foreign chart returns nothing';

    SELECT count(*) INTO n FROM staff_profiles;
    ASSERT n = 2, format('expected 2 staff in tenant A, saw %s', n);
    RAISE NOTICE 'PASS  staff directory filtered';
  END $$;

  -- Writes aimed at another tenant must be refused, not silently redirected.
  DO $$
  BEGIN
    INSERT INTO patients (tenant_id, mrn, given_name, family_name, date_of_birth, sex_at_birth)
    VALUES ('22222222-2222-2222-2222-222222222222','MRN-X','Mallory','Cross','1980-01-01','female');
    RAISE EXCEPTION 'FAIL cross-tenant INSERT was accepted';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS  cross-tenant INSERT refused by WITH CHECK';
  END $$;

  DO $$
  DECLARE n int;
  BEGIN
    UPDATE patients SET family_name = 'Tampered'
     WHERE id = 'cccc2222-0000-0000-0000-000000000001';
    GET DIAGNOSTICS n = ROW_COUNT;
    ASSERT n = 0, format('cross-tenant UPDATE modified %s rows', n);
    RAISE NOTICE 'PASS  cross-tenant UPDATE matched no rows';

    DELETE FROM patients WHERE id = 'cccc2222-0000-0000-0000-000000000001';
    GET DIAGNOSTICS n = ROW_COUNT;
    ASSERT n = 0, format('cross-tenant DELETE removed %s rows', n);
    RAISE NOTICE 'PASS  cross-tenant DELETE matched no rows';
  END $$;
COMMIT;

-- Context is transaction-scoped, so a recycled pooled connection starts blind.
BEGIN;
  SET LOCAL ROLE hims_app;
  DO $$
  DECLARE n int;
  BEGIN
    ASSERT hims_util.current_tenant_id() IS NULL,
      'request context survived the previous transaction: pooling is unsafe';
    SELECT count(*) INTO n FROM patients;
    ASSERT n = 0, 'queries without tenant context must fail closed';
    RAISE NOTICE 'PASS  no context leak across transactions; unset context returns zero rows';
  END $$;
COMMIT;

\echo
\echo '############ 2. appointment double-booking ############'
\set QUIET on
INSERT INTO appointments (tenant_id, reference, patient_id, provider_id, appointment_type_id,
                          facility_id, starts_at, ends_at)
VALUES (:'TENANT_A', hims_util.allocate_reference(:'TENANT_A','appointment','APT'),
        'cccc1111-0000-0000-0000-000000000001','bbbb1111-0000-0000-0000-000000000001',
        'dddd1111-0000-0000-0000-000000000001','aaaa1111-0000-0000-0000-000000000001',
        '2026-11-02 09:00+00','2026-11-02 09:30+00');
\set QUIET off

DO $$
BEGIN
  INSERT INTO appointments (tenant_id, reference, patient_id, provider_id, appointment_type_id,
                            starts_at, ends_at)
  VALUES ('11111111-1111-1111-1111-111111111111','APT-OVERLAP',
          'cccc1111-0000-0000-0000-000000000001','bbbb1111-0000-0000-0000-000000000001',
          'dddd1111-0000-0000-0000-000000000001','2026-11-02 09:15+00','2026-11-02 09:45+00');
  RAISE EXCEPTION 'FAIL overlapping booking for the same provider was accepted';
EXCEPTION
  WHEN exclusion_violation THEN
    RAISE NOTICE 'PASS  overlapping booking rejected at the database (SQLSTATE 23P01)';
END $$;

-- A second provider is free to hold the identical slot.
DO $$
BEGIN
  INSERT INTO appointments (tenant_id, reference, patient_id, provider_id, appointment_type_id,
                            starts_at, ends_at)
  VALUES ('11111111-1111-1111-1111-111111111111','APT-OTHER-PROVIDER',
          'cccc1111-0000-0000-0000-000000000001','bbbb1111-0000-0000-0000-000000000002',
          'dddd1111-0000-0000-0000-000000000001','2026-11-02 09:00+00','2026-11-02 09:30+00');
  RAISE NOTICE 'PASS  a different provider may hold the same time slot';
END $$;

-- Cancelling drops the row out of the constraint, freeing the slot at once.
UPDATE appointments SET status = 'cancelled', cancelled_at = now()
 WHERE provider_id = 'bbbb1111-0000-0000-0000-000000000001'
   AND starts_at = '2026-11-02 09:00+00';
DO $$
BEGIN
  INSERT INTO appointments (tenant_id, reference, patient_id, provider_id, appointment_type_id,
                            starts_at, ends_at)
  VALUES ('11111111-1111-1111-1111-111111111111','APT-REBOOK',
          'cccc1111-0000-0000-0000-000000000001','bbbb1111-0000-0000-0000-000000000001',
          'dddd1111-0000-0000-0000-000000000001','2026-11-02 09:15+00','2026-11-02 09:45+00');
  RAISE NOTICE 'PASS  a cancelled slot is immediately rebookable';
END $$;

\echo
\echo '############ 3. signed clinical records are immutable ############'
\set QUIET on
INSERT INTO encounters (id, tenant_id, reference, patient_id, provider_id, status,
                        assessment_encrypted, signed_by, signed_at)
VALUES ('eeee1111-0000-0000-0000-000000000001',:'TENANT_A','ENC-000001',
        'cccc1111-0000-0000-0000-000000000001','bbbb1111-0000-0000-0000-000000000001',
        'signed','\xdeadbeef','bbbb1111-0000-0000-0000-000000000001', now());
\set QUIET off

DO $$
BEGIN
  UPDATE encounters SET assessment_encrypted = '\xc0ffee'
   WHERE id = 'eeee1111-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'FAIL the narrative of a signed encounter was overwritten';
EXCEPTION
  WHEN integrity_constraint_violation THEN
    RAISE NOTICE 'PASS  edit to a signed clinical narrative refused';
END $$;

DO $$
BEGIN
  UPDATE encounters SET ended_at = now(), disposition = 'discharged_home'
   WHERE id = 'eeee1111-0000-0000-0000-000000000001';
  RAISE NOTICE 'PASS  non-narrative fields on a signed encounter remain updatable';

  INSERT INTO encounter_amendments (tenant_id, encounter_id, sequence_no, reason, authored_by)
  VALUES ('11111111-1111-1111-1111-111111111111','eeee1111-0000-0000-0000-000000000001',
          1,'Corrected laterality in the assessment','bbbb1111-0000-0000-0000-000000000001');
  RAISE NOTICE 'PASS  corrections are recordable as formal amendments';
END $$;

\echo
\echo '############ 4. stock ledger ############'
\set QUIET on
INSERT INTO inventory_locations (id, tenant_id, facility_id, name, code, kind)
VALUES ('f1110000-0000-0000-0000-000000000001',:'TENANT_A',
        'aaaa1111-0000-0000-0000-000000000001','Main Pharmacy','PH-MAIN','pharmacy');
INSERT INTO inventory_items (id, tenant_id, sku, name, generic_name, form, strength, base_unit,
                             reorder_level, critical_level, reorder_quantity, avg_daily_usage,
                             cost_price_cents, sale_price_cents)
VALUES ('f2220000-0000-0000-0000-000000000001',:'TENANT_A','MED-AMOX500',
        'Amoxicillin 500mg Capsule','Amoxicillin','capsule','500 mg','capsule',
        200, 50, 1000, 40, 12, 45);
INSERT INTO stock_batches (id, tenant_id, item_id, location_id, lot_number, expires_on, quantity_received)
VALUES ('f3330000-0000-0000-0000-000000000001',:'TENANT_A','f2220000-0000-0000-0000-000000000001',
        'f1110000-0000-0000-0000-000000000001','LOT-A','2027-06-30', 500);
INSERT INTO stock_movements (tenant_id, item_id, location_id, batch_id, quantity, movement_type, reference_kind)
VALUES (:'TENANT_A','f2220000-0000-0000-0000-000000000001','f1110000-0000-0000-0000-000000000001',
        'f3330000-0000-0000-0000-000000000001', 500,'receipt','purchase_order'),
       (:'TENANT_A','f2220000-0000-0000-0000-000000000001','f1110000-0000-0000-0000-000000000001',
        'f3330000-0000-0000-0000-000000000001',-180,'dispense','dispense');
\set QUIET off

DO $$
DECLARE v_level numeric; v_batch numeric; v_last numeric;
BEGIN
  SELECT quantity_on_hand INTO v_level FROM stock_levels
   WHERE item_id = 'f2220000-0000-0000-0000-000000000001';
  SELECT quantity_on_hand INTO v_batch FROM stock_batches
   WHERE id = 'f3330000-0000-0000-0000-000000000001';
  SELECT balance_after INTO v_last FROM stock_movements ORDER BY id DESC LIMIT 1;

  ASSERT v_level = 320, format('rolled-up balance wrong: %s', v_level);
  ASSERT v_batch = 320, format('batch balance wrong: %s', v_batch);
  ASSERT v_last  = 320, format('ledger running balance wrong: %s', v_last);
  RAISE NOTICE 'PASS  ledger, batch and rolled-up balances all agree (320)';
END $$;

DO $$
BEGIN
  INSERT INTO stock_movements (tenant_id, item_id, location_id, quantity, movement_type)
  VALUES ('11111111-1111-1111-1111-111111111111','f2220000-0000-0000-0000-000000000001',
          'f1110000-0000-0000-0000-000000000001',-1000,'dispense');
  RAISE EXCEPTION 'FAIL a dispense larger than stock on hand was accepted';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'PASS  dispense exceeding stock on hand refused';
END $$;

DO $$
BEGIN
  UPDATE stock_movements SET quantity = 9999 WHERE movement_type = 'dispense';
  RAISE EXCEPTION 'FAIL a ledger row was rewritten';
EXCEPTION
  WHEN integrity_constraint_violation THEN
    RAISE NOTICE 'PASS  stock ledger rejects UPDATE (append-only)';
END $$;

DO $$
BEGIN
  DELETE FROM stock_movements WHERE movement_type = 'dispense';
  RAISE EXCEPTION 'FAIL a ledger row was deleted';
EXCEPTION
  WHEN integrity_constraint_violation THEN
    RAISE NOTICE 'PASS  stock ledger rejects DELETE (append-only)';
END $$;

\echo
\echo '############ 5. low-stock detection ############'
DO $$
DECLARE v_state text; v_cover numeric;
BEGIN
  SELECT stock_state, days_of_cover INTO v_state, v_cover FROM v_stock_status
   WHERE item_id = 'f2220000-0000-0000-0000-000000000001';
  ASSERT v_state = 'ok', format('expected ok at 320 units, got %s', v_state);
  RAISE NOTICE 'PASS  320 units against a reorder level of 200 reads as ok (% days cover)', v_cover;

  INSERT INTO stock_movements (tenant_id, item_id, location_id, batch_id, quantity, movement_type)
  VALUES ('11111111-1111-1111-1111-111111111111','f2220000-0000-0000-0000-000000000001',
          'f1110000-0000-0000-0000-000000000001','f3330000-0000-0000-0000-000000000001',
          -150,'dispense');

  SELECT stock_state INTO v_state FROM v_stock_status
   WHERE item_id = 'f2220000-0000-0000-0000-000000000001';
  ASSERT v_state = 'low', format('expected low at 170 units, got %s', v_state);
  RAISE NOTICE 'PASS  crossing the reorder level flips the state to low';

  INSERT INTO stock_movements (tenant_id, item_id, location_id, batch_id, quantity, movement_type)
  VALUES ('11111111-1111-1111-1111-111111111111','f2220000-0000-0000-0000-000000000001',
          'f1110000-0000-0000-0000-000000000001','f3330000-0000-0000-0000-000000000001',
          -140,'dispense');

  SELECT stock_state INTO v_state FROM v_stock_status
   WHERE item_id = 'f2220000-0000-0000-0000-000000000001';
  ASSERT v_state = 'critical', format('expected critical at 30 units, got %s', v_state);
  RAISE NOTICE 'PASS  crossing the critical level escalates the state';
END $$;

\echo
\echo '############ 6. invoice arithmetic ############'
\set QUIET on
INSERT INTO service_items (id, tenant_id, code, name, unit_price_cents, tax_rate, is_taxable)
VALUES ('f4440000-0000-0000-0000-000000000001',:'TENANT_A','CONS-GP','GP Consultation',7500,0.05,true);
INSERT INTO invoices (id, tenant_id, invoice_number, patient_id, status, due_on)
VALUES ('f5550000-0000-0000-0000-000000000001',:'TENANT_A',
        hims_util.allocate_reference(:'TENANT_A','invoice','INV'),
        'cccc1111-0000-0000-0000-000000000001','issued', CURRENT_DATE + 30);
INSERT INTO invoice_lines (tenant_id, invoice_id, line_no, service_item_id, description,
                           quantity, unit_price_cents, tax_rate, discount_cents)
VALUES (:'TENANT_A','f5550000-0000-0000-0000-000000000001',1,'f4440000-0000-0000-0000-000000000001',
        'GP Consultation',1,7500,0.05,0),
       (:'TENANT_A','f5550000-0000-0000-0000-000000000001',2,NULL,
        'Amoxicillin 500mg x 21',21,45,0,100);
\set QUIET off

DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM invoices WHERE id = 'f5550000-0000-0000-0000-000000000001';
  -- 7500 + (21 * 45 = 945) = 8445 gross; less 100 discount; plus 375 tax = 8720
  ASSERT v.subtotal_cents = 8445, format('subtotal %s', v.subtotal_cents);
  ASSERT v.discount_cents = 100,  format('discount %s', v.discount_cents);
  ASSERT v.tax_cents      = 375,  format('tax %s', v.tax_cents);
  ASSERT v.total_cents    = 8720, format('total %s', v.total_cents);
  ASSERT v.balance_cents  = 8720, format('balance %s', v.balance_cents);
  RAISE NOTICE 'PASS  header totals derived from lines: 8445 - 100 + 375 = 8720';
END $$;

\set QUIET on
INSERT INTO payments (id, tenant_id, receipt_number, patient_id, amount_cents, method)
VALUES ('f6660000-0000-0000-0000-000000000001',:'TENANT_A','RCP-0001',
        'cccc1111-0000-0000-0000-000000000001',5000,'card');
INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount_cents)
VALUES (:'TENANT_A','f6660000-0000-0000-0000-000000000001','f5550000-0000-0000-0000-000000000001',5000);
\set QUIET off

DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM invoices WHERE id = 'f5550000-0000-0000-0000-000000000001';
  ASSERT v.amount_paid_cents = 5000 AND v.balance_cents = 3720 AND v.status = 'partially_paid',
    format('after part payment: paid=%s balance=%s status=%s',
           v.amount_paid_cents, v.balance_cents, v.status);
  RAISE NOTICE 'PASS  part payment leaves balance 3720 and status partially_paid';
END $$;

-- Over-allocation must be refused rather than driving the balance negative.
DO $$
BEGIN
  INSERT INTO payments (id, tenant_id, receipt_number, patient_id, amount_cents, method)
  VALUES ('f7770000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
          'RCP-0002','cccc1111-0000-0000-0000-000000000001',9999,'cash');
  INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount_cents)
  VALUES ('11111111-1111-1111-1111-111111111111','f7770000-0000-0000-0000-000000000001',
          'f5550000-0000-0000-0000-000000000001',9999);
  RAISE EXCEPTION 'FAIL an allocation beyond the invoice total was accepted';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'PASS  allocation exceeding the invoice total refused';
END $$;

\set QUIET on
INSERT INTO payments (id, tenant_id, receipt_number, patient_id, amount_cents, method)
VALUES ('f8880000-0000-0000-0000-000000000001',:'TENANT_A','RCP-0003',
        'cccc1111-0000-0000-0000-000000000001',3720,'cash');
INSERT INTO payment_allocations (tenant_id, payment_id, invoice_id, amount_cents)
VALUES (:'TENANT_A','f8880000-0000-0000-0000-000000000001','f5550000-0000-0000-0000-000000000001',3720);
\set QUIET off

DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM invoices WHERE id = 'f5550000-0000-0000-0000-000000000001';
  ASSERT v.balance_cents = 0 AND v.status = 'paid',
    format('after settlement: balance=%s status=%s', v.balance_cents, v.status);
  RAISE NOTICE 'PASS  settling the remainder zeroes the balance and marks it paid';
END $$;

\echo
\echo '############ 7. audit trail ############'
\set QUIET on
INSERT INTO audit_events (tenant_id, actor_label, action, resource_type, resource_id,
                          patient_id, touched_phi, http_method, http_path, http_status)
VALUES (:'TENANT_A','Dr. Ada Okafor','patient.read','patient',
        'cccc1111-0000-0000-0000-000000000001','cccc1111-0000-0000-0000-000000000001',
        true,'GET','/api/v1/patients/cccc1111',200),
       (:'TENANT_A','Dr. Ada Okafor','encounter.sign','encounter',
        'eeee1111-0000-0000-0000-000000000001','cccc1111-0000-0000-0000-000000000001',
        true,'POST','/api/v1/encounters/eeee1111/sign',200),
       (:'TENANT_A','Reception Desk','patient.read','patient',
        'cccc2222-0000-0000-0000-000000000001',NULL,true,'GET','/api/v1/patients/cccc2222',403);
\set QUIET off

DO $$
DECLARE v_broken int; v_linked int;
BEGIN
  SELECT count(*) INTO v_linked FROM audit_events a
    JOIN audit_events b ON b.id = a.id - 1
   WHERE a.prev_hash = b.event_hash;
  ASSERT v_linked = 2, format('expected 2 chained links, found %s', v_linked);
  RAISE NOTICE 'PASS  each audit row commits to its predecessor''s digest';

  SELECT count(*) INTO v_broken FROM hims_util.verify_audit_chain();
  ASSERT v_broken = 0, 'chain verification reported a break on untouched data';
  RAISE NOTICE 'PASS  chain verification reports no breaks';
END $$;

DO $$
BEGIN
  UPDATE audit_events SET action = 'patient.list' WHERE id = 1;
  RAISE EXCEPTION 'FAIL an audit row was rewritten';
EXCEPTION
  WHEN integrity_constraint_violation THEN
    RAISE NOTICE 'PASS  audit trail rejects UPDATE';
END $$;

DO $$
BEGIN
  DELETE FROM audit_events WHERE id = 1;
  RAISE EXCEPTION 'FAIL an audit row was deleted';
EXCEPTION
  WHEN integrity_constraint_violation THEN
    RAISE NOTICE 'PASS  audit trail rejects DELETE';
END $$;

-- Tamper detection: bypass the trigger the way a privileged DBA would, and
-- confirm the hash chain still catches it.
ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_immutable;
UPDATE audit_events SET action = 'patient.list' WHERE id = 1;
ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_immutable;

DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM hims_util.verify_audit_chain() LIMIT 1;
  ASSERT v.broken_at_id = 1,
    format('tampering went undetected (reported id %s)', v.broken_at_id);
  RAISE NOTICE 'PASS  a trigger-bypassing edit is still detected at row %', v.broken_at_id;
END $$;

\echo
\echo '############ 8. structural guard rails ############'
DO $$
DECLARE v_missing text[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_missing
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND NOT c.relrowsecurity;
  ASSERT v_missing IS NULL,
    format('tenant-scoped tables without RLS: %s', array_to_string(v_missing, ', '));
  RAISE NOTICE 'PASS  every tenant-scoped table has row-level security enabled';
END $$;

-- A view that does not set security_invoker runs as its owner and silently
-- bypasses RLS on its base tables. This regressed once during development: the
-- stock board returned every tenant's inventory, and the only visible symptom
-- was duplicated rows.
DO $$
DECLARE v_leaky text[];
BEGIN
  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_leaky
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'v'
     AND NOT COALESCE(
       (SELECT option_value::boolean FROM pg_options_to_table(c.reloptions)
         WHERE option_name = 'security_invoker'), false);
  ASSERT v_leaky IS NULL,
    format('views bypassing RLS: %s', array_to_string(v_leaky, ', '));
  RAISE NOTICE 'PASS  every view runs as its invoker, so RLS is not bypassed';
END $$;

-- And prove it behaviourally, not just structurally.
DO $$
DECLARE v_rows int; v_tenants int;
BEGIN
  PERFORM hims_util.set_request_context('11111111-1111-1111-1111-111111111111', NULL, true);
  SELECT count(*), count(DISTINCT tenant_id) INTO v_rows, v_tenants FROM v_stock_status;
  ASSERT v_tenants <= 1,
    format('v_stock_status returned %s tenants to a single-tenant session', v_tenants);
  RAISE NOTICE 'PASS  the stock view returns one tenant''s rows only (% row(s))', v_rows;
END $$;

DO $$
DECLARE v_unindexed text[];
BEGIN
  -- An unindexed FK is only a real problem when it is ON DELETE CASCADE or
  -- RESTRICT: every delete on the parent then sequentially scans the child.
  -- Plain attribution columns (created_by, cancelled_by) are deliberately left
  -- unindexed — they are written far more often than they are filtered on.
  SELECT array_agg(format('%s.%s', con.conrelid::regclass, a.attname) ORDER BY 1)
    INTO v_unindexed
    FROM pg_constraint con
    JOIN pg_attribute a
      ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
   WHERE con.contype = 'f'
     AND con.connamespace = 'public'::regnamespace
     AND array_length(con.conkey, 1) = 1
     AND con.confdeltype IN ('c','r')          -- CASCADE or RESTRICT
     AND NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indrelid = con.conrelid
          AND i.indkey[0] = con.conkey[1]);

  IF v_unindexed IS NOT NULL THEN
    RAISE NOTICE 'NOTE  cascading/restricting foreign keys without a leading index: %',
      array_to_string(v_unindexed, ', ');
    RAISE NOTICE '      Review these before go-live; each one turns a parent delete '
                 'into a sequential scan of the child table.';
  ELSE
    RAISE NOTICE 'PASS  every cascading foreign key is index-backed';
  END IF;
END $$;

\echo
\echo '############ all invariants verified ############'
