-- =============================================================================
-- 0021  Telling the hospital their payment landed
-- -----------------------------------------------------------------------------
-- 0019 told them an invoice exists. Nothing told them it had been settled.
-- The hospital paid by bank transfer or mobile money into an account they
-- cannot see the other side of, and then heard nothing at all — the only way
-- to find out the money had been applied was to sign in and look.
--
-- Worse, the invoice email 0019 ships ends with "a payment can take a day or
-- two to be recorded against your account", which promises a confirmation
-- that did not exist.
--
-- THREE EVENTS, not one, because interpolation here is deliberately
-- {{key}}-only with no conditionals (see the worker's `render`). A template
-- that has to say "and {{balance}} remains" OR "nothing further is due"
-- cannot branch, and a receipt that tells a hospital which has just cleared
-- its account that it still owes {{balance}} — rendered as an empty string —
-- is the kind of billing message that generates a phone call.
--
--   subscription_payment_received  a payment, with a balance still to go
--   subscription_invoice_settled   the payment that cleared the invoice
--   subscription_payment_voided    a payment reversed back off the invoice
--
-- THE REFERENCE IS IN EVERY ONE of them. The hospital's own record of this
-- payment is a transfer number or an M-Pesa code on their bank statement,
-- and quoting it back is what lets them match our receipt to their outgoing
-- without ringing anyone.
--
-- THE VOID NOTICE EXISTS because the alternative is worse. Voiding is how an
-- operator corrects a mis-keyed amount, so the hospital will sometimes get a
-- reversal followed by a fresh receipt — mildly noisy, and each message is
-- true. Staying silent means an outstanding balance that climbs back up with
-- no explanation, which is the version that produces an angry call.
--
-- SYSTEM ROWS, so `tenant_id IS NULL`. That needs the FORCE bracket migration
-- 0012 documented: FORCE subjects the table owner to the policy too, so the
-- owner cannot write a NULL-tenant row without lifting it for the duration.
-- The whole migration is one transaction, so the table is never unprotected
-- to anyone else.
--
-- NONE is marked `phi_safe`. They carry no patient data, but `phi_safe` is
-- what lets a template out over SMS, and a payment receipt naming a sum of
-- money has no business landing unencrypted on a lock screen.
-- =============================================================================

ALTER TABLE notification_templates NO FORCE ROW LEVEL SECURITY;

INSERT INTO notification_templates (tenant_id, key, channel, locale, subject, body, phi_safe)
VALUES
  -- ---- A payment, with something still outstanding ------------------------
  (NULL, 'subscription_payment_received', 'email', 'en',
   'Payment received — {{amount}} against {{invoiceNumber}}',
   'We have recorded {{amount}} against invoice {{invoiceNumber}} for {{hospitalName}}, '
   'received {{receivedOn}} by {{method}}.'
     || chr(10) || chr(10) ||
   'Your reference: {{reference}}'
     || chr(10) || chr(10) ||
   '{{balance}} remains outstanding on this invoice, due {{dueDate}}.'
     || chr(10) || chr(10) ||
   'The invoice, with every payment recorded against it: {{invoiceUrl}}'
     || chr(10) || chr(10) ||
   'If this does not match your records, reply to this message and we will '
   'look into it before anything else happens on the account.',
   false),

  (NULL, 'subscription_payment_received', 'in_app', 'en',
   'Payment received — {{amount}}',
   '{{amount}} recorded against {{invoiceNumber}} ({{method}}, {{reference}}). '
   '{{balance}} still outstanding, due {{dueDate}}. {{invoiceUrl}}',
   false),

  -- ---- The payment that cleared the invoice -------------------------------
  (NULL, 'subscription_invoice_settled', 'email', 'en',
   'Invoice {{invoiceNumber}} paid in full — thank you',
   'We have recorded {{amount}}, received {{receivedOn}} by {{method}}, and '
   'invoice {{invoiceNumber}} for {{hospitalName}} is now paid in full.'
     || chr(10) || chr(10) ||
   'Your reference: {{reference}}'
     || chr(10) || chr(10) ||
   'Nothing further is due on this invoice. Thank you.'
     || chr(10) || chr(10) ||
   'A receipted copy, showing every payment against it: {{invoiceUrl}}'
     || chr(10) || chr(10) ||
   'If this does not match your records, reply to this message and we will '
   'look into it.',
   false),

  (NULL, 'subscription_invoice_settled', 'in_app', 'en',
   'Invoice {{invoiceNumber}} paid in full',
   '{{amount}} recorded ({{method}}, {{reference}}). Nothing further is due on '
   'this invoice. {{invoiceUrl}}',
   false),

  -- ---- A payment taken back off the invoice -------------------------------
  -- Says what it was, why, and what the balance is NOW. A reversal notice
  -- that does not restate the outstanding amount leaves the reader to work
  -- out what they owe from two messages, which is how the wrong figure gets
  -- paid next.
  (NULL, 'subscription_payment_voided', 'email', 'en',
   'Correction: {{amount}} reversed on {{invoiceNumber}}',
   'A payment of {{amount}} recorded against invoice {{invoiceNumber}} for '
   '{{hospitalName}} has been reversed.'
     || chr(10) || chr(10) ||
   'Reason: {{reason}}'
     || chr(10) || chr(10) ||
   'The outstanding balance on this invoice is now {{balance}}, due {{dueDate}}.'
     || chr(10) || chr(10) ||
   'The invoice, with every payment and reversal recorded against it: {{invoiceUrl}}'
     || chr(10) || chr(10) ||
   'This usually means a payment was entered incorrectly and is being '
   'recorded again correctly. If you were not expecting it, reply to this '
   'message before paying anything further.',
   false),

  (NULL, 'subscription_payment_voided', 'in_app', 'en',
   'Correction: {{amount}} reversed on {{invoiceNumber}}',
   '{{reason}}. The outstanding balance is now {{balance}}, due {{dueDate}}. '
   '{{invoiceUrl}}',
   false)
ON CONFLICT (tenant_id, key, channel, locale) DO NOTHING;

ALTER TABLE notification_templates FORCE ROW LEVEL SECURITY;

-- Prove the bracket closed and the rows landed, exactly as 0012 and 0019 do.
-- A migration that left the table unprotected would be a silent cross-tenant
-- hole; one that silently inserted nothing would leave every payment
-- confirmation unrenderable, with the failure appearing only in the worker's
-- log long after this ran.
DO $$
DECLARE
  v_expected text[] := ARRAY[
    'subscription_payment_received',
    'subscription_invoice_settled',
    'subscription_payment_voided'
  ];
  v_key text;
BEGIN
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'notification_templates'::regclass) THEN
    RAISE EXCEPTION 'notification_templates was left without FORCE ROW LEVEL SECURITY';
  END IF;

  FOREACH v_key IN ARRAY v_expected LOOP
    IF (SELECT count(*) FROM notification_templates
         WHERE tenant_id IS NULL AND key = v_key) <> 2 THEN
      RAISE EXCEPTION 'expected an email and an in_app template for %', v_key;
    END IF;
  END LOOP;
END;
$$;
