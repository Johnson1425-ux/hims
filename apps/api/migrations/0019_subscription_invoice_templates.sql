-- =============================================================================
-- 0019  Telling the hospital an invoice exists
-- -----------------------------------------------------------------------------
-- 0018 built the ledger and left the delivery out: an invoice was issued into
-- the vendor's console and the hospital was never told. These two templates
-- close that, on the two channels that work without a third party —
-- `in_app`, which the notification bell already renders, and `email`, which
-- the existing outbox sends once MAIL_PROVIDER is configured and logs until
-- then.
--
-- SYSTEM ROWS, so `tenant_id IS NULL` and every hospital resolves the same
-- text. That needs the FORCE bracket migration 0012 documented: FORCE
-- subjects the table owner to the policy too, so the owner cannot write a
-- NULL-tenant row without lifting it for the duration. The whole migration is
-- one transaction, so there is no window in which the table is unprotected.
--
-- NEITHER IS MARKED `phi_safe`, which is correct and worth stating because it
-- looks conservative: these carry no patient data at all. But `phi_safe` is
-- what lets a template out over SMS, and a subscription invoice has no
-- business on a channel that lands unencrypted on a lock screen. Leaving it
-- false means the worker refuses if anyone ever queues one as an SMS.
-- =============================================================================

ALTER TABLE notification_templates NO FORCE ROW LEVEL SECURITY;

INSERT INTO notification_templates (tenant_id, key, channel, locale, subject, body, phi_safe)
VALUES
  -- The amount and the due date are in the first line on purpose. This is
  -- read on a phone, in a list, and the two questions are always "how much"
  -- and "by when".
  (NULL, 'subscription_invoice_issued', 'email', 'en',
   'Invoice {{invoiceNumber}} — {{amount}} due {{dueDate}}',
   'Invoice {{invoiceNumber}} for {{hospitalName}} is {{amount}}, due {{dueDate}}.'
     || chr(10) || chr(10) ||
   'It covers your {{tier}} subscription from {{periodStart}} to {{periodEnd}}.'
     || chr(10) || chr(10) ||
   'Download the invoice: {{invoiceUrl}}'
     || chr(10) || chr(10) ||
   'The link opens the PDF without signing in, so treat it as you would the '
   'invoice itself. It stops working after 90 days; ask us for a new one if '
   'you need it after that.'
     || chr(10) || chr(10) ||
   'If you have already paid, thank you — a payment can take a day or two to '
   'be recorded against your account.',
   false),

  (NULL, 'subscription_invoice_issued', 'in_app', 'en',
   'Invoice {{invoiceNumber}} — {{amount}} due {{dueDate}}',
   '{{amount}} for your {{tier}} subscription, {{periodStart}} to {{periodEnd}}. '
   'Download it: {{invoiceUrl}}',
   false)
ON CONFLICT (tenant_id, key, channel, locale) DO NOTHING;

ALTER TABLE notification_templates FORCE ROW LEVEL SECURITY;

-- Prove the bracket closed and the rows landed, exactly as 0012 does. A
-- migration that left the table unprotected would be a silent cross-tenant
-- hole, and one that silently inserted nothing would leave invoices
-- undeliverable with no error anywhere.
DO $$
BEGIN
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'notification_templates'::regclass) THEN
    RAISE EXCEPTION 'notification_templates was left without FORCE ROW LEVEL SECURITY';
  END IF;

  IF (SELECT count(*) FROM notification_templates
       WHERE tenant_id IS NULL AND key = 'subscription_invoice_issued') <> 2 THEN
    RAISE EXCEPTION 'the subscription invoice templates were not created';
  END IF;
END;
$$;
