-- =============================================================================
-- 0014  Currency: Tanzanian shilling, and one place that decides
-- -----------------------------------------------------------------------------
-- Four tables carried `DEFAULT 'USD'` — tenants, invoices, payments and
-- purchase_orders — which encoded a deployment assumption in the schema.
-- The tenant row is the only sensible authority: it already has `currency` and
-- `locale`, and a multi-tenant system cannot have a single right answer.
--
-- So the column defaults become TZS, matching the deployment this is being set
-- up for, and the tenant's own value remains what the application reads.
--
-- A NOTE ON SCALE, because it is the part that bites.
--
-- Every amount in this schema is an integer in the currency's MINOR UNIT —
-- that is what the `*_cents` suffix means, and it is why no amount is ever a
-- float. How many minor units make a unit is a property of the CURRENCY, not
-- the constant 100: the Tanzanian shilling is quoted in whole shillings, the
-- senti is long obsolete, and ICU's cash-rounding data gives TZS zero fraction
-- digits even though ISO 4217 still nominally lists two. For TZS the minor
-- unit IS the shilling, so nothing is divided on the way to a screen.
--
-- Getting that wrong is not cosmetic: dividing by a hundred would state every
-- price in this system at a hundredth of its value, on invoices and claims
-- alike. apps/web/src/lib/format.ts holds the one implementation, keyed on the
-- currency code, so the rule lives in exactly one place on each side.
-- =============================================================================

ALTER TABLE tenants         ALTER COLUMN currency SET DEFAULT 'TZS';
ALTER TABLE invoices        ALTER COLUMN currency SET DEFAULT 'TZS';
ALTER TABLE payments        ALTER COLUMN currency SET DEFAULT 'TZS';
ALTER TABLE purchase_orders ALTER COLUMN currency SET DEFAULT 'TZS';

-- The tenant locale decides how the amount is rendered, and only an East
-- African locale renders TZS as "TSh" rather than the bare ISO code.
ALTER TABLE tenants ALTER COLUMN locale SET DEFAULT 'en-TZ';

-- Existing rows. A deployment that has only ever run the seed holds nothing
-- but demo data, and leaving half the rows in USD would make every total a
-- mixed-currency sum — which is worse than either answer on its own.
--
-- FORCE ROW LEVEL SECURITY applies to the table owner too, and this migration
-- runs without a tenant context, so the bracket below lets it see every row.
-- It is closed again immediately, and asserted closed at the end.
--
-- `tenants` is NOT in the bracket: 0013 deliberately left it unforced so the
-- login bootstrap can resolve an email address to a tenant before any context
-- exists. Re-forcing it here would have been a one-line way to make the whole
-- system unloggable-into, with nothing in this migration's subject matter to
-- suggest that is what had happened.
ALTER TABLE invoices        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE payments        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders NO FORCE ROW LEVEL SECURITY;

UPDATE tenants         SET currency = 'TZS' WHERE currency = 'USD';
UPDATE tenants         SET locale   = 'en-TZ' WHERE locale = 'en-US';
UPDATE invoices        SET currency = 'TZS' WHERE currency = 'USD';
UPDATE payments        SET currency = 'TZS' WHERE currency = 'USD';
UPDATE purchase_orders SET currency = 'TZS' WHERE currency = 'USD';

ALTER TABLE invoices        FORCE ROW LEVEL SECURITY;
ALTER TABLE payments        FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  unforced text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO unforced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('invoices','payments','purchase_orders')
     AND NOT c.relforcerowsecurity;

  IF unforced IS NOT NULL THEN
    RAISE EXCEPTION 'left without FORCE ROW LEVEL SECURITY: %', unforced;
  END IF;
END $$;
