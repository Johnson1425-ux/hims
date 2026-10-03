-- =============================================================================
-- 0012  Built-in notification templates
-- -----------------------------------------------------------------------------
-- These are SYSTEM data (tenant_id IS NULL), in the same category as the
-- permission catalogue and the system roles in migration 0002 — not demo data.
--
-- They live in a migration rather than the seed for a concrete reason: a row
-- with `tenant_id IS NULL` cannot be written by any tenant-scoped session, so
-- the seed (which runs as hims_owner against a FORCE'd table) cannot create
-- them at all.
--
-- WRITING SYSTEM ROWS AFTER MIGRATION 0010
--
-- `FORCE ROW LEVEL SECURITY` subjects the table OWNER to its policies too, and
-- this migration runs after 0010 enabled it. So the owner cannot insert a
-- NULL-tenant row either: the write fails with 42501. The fix is to lift FORCE
-- for the duration of the insert and restore it immediately, inside the same
-- transaction the runner already wraps each migration in — so there is no
-- window in which the table is unprotected and no partial state if this fails.
--
-- Any future migration seeding system rows into a tenant-scoped table needs
-- the same bracket. Migrations numbered before 0010 do not.
--
-- `phi_safe` is the load-bearing column. An SMS traverses carriers in the clear
-- and lands on a lock screen: a reminder may say WHEN and WHERE, never WHY.
-- The notification worker refuses to render an unmarked template on SMS or
-- voice, so marking one here is a deliberate review step, not a formality.
-- =============================================================================

ALTER TABLE notification_templates NO FORCE ROW LEVEL SECURITY;

INSERT INTO notification_templates (tenant_id, key, channel, locale, subject, body, phi_safe)
VALUES
  -- Appointment reminders: time, place and clinician only. No reason for visit,
  -- no department that would imply a diagnosis.
  (NULL, 'appointment_reminder', 'sms', 'en', NULL,
   'Reminder: your appointment with {{providerName}} is on {{appointmentDate}} at '
   '{{appointmentTime}}, {{locationName}}. Reply STOP to opt out.',
   true),

  (NULL, 'appointment_reminder', 'email', 'en', 'Your upcoming appointment',
   'Your appointment with {{providerName}} is scheduled for {{appointmentDate}} at '
   '{{appointmentTime}} at {{locationName}}.' || chr(10) || chr(10) ||
   'If you can no longer attend, please let us know as early as you can so the '
   'slot can be offered to someone else.',
   true),

  (NULL, 'appointment_confirmation', 'email', 'en', 'Appointment confirmed',
   'Your appointment with {{providerName}} is confirmed for {{appointmentDate}} at '
   '{{appointmentTime}}, {{locationName}}.',
   true),

  -- An earlier slot has freed up. Deliberately says nothing about what it is for.
  (NULL, 'waitlist_slot_offer', 'sms', 'en', NULL,
   'An earlier appointment has become available on {{appointmentDate}} at '
   '{{appointmentTime}}. Call the clinic within 4 hours to take it.',
   true),

  -- Security mail. Carries no PHI at all, only account mechanics.
  (NULL, 'password_reset', 'email', 'en', 'Reset your password',
   'Use this link to set a new password: {{resetUrl}}' || chr(10) || chr(10) ||
   'The link expires in one hour. If you did not request this, you can ignore '
   'this message and your password will stay as it is.',
   true),

  (NULL, 'staff_invitation', 'email', 'en', 'You have been invited',
   'Hello {{fullName}},' || chr(10) || chr(10) ||
   'An account has been created for you. Set your password here: {{inviteUrl}}' ||
   chr(10) || chr(10) || 'The link expires in 7 days.',
   true),

  -- Internal, in-app only: never leaves the application, so clinical detail is
  -- acceptable here in a way it would not be on any external channel.
  (NULL, 'stock_alert', 'in_app', 'en', 'Stock alert', '{{message}}', true),

  (NULL, 'early_warning', 'in_app', 'en', 'Early warning score requires review',
   '{{message}}', true),

  (NULL, 'critical_result', 'in_app', 'en', 'Critical result awaiting acknowledgement',
   '{{message}}', true)

ON CONFLICT (tenant_id, key, channel, locale) DO NOTHING;

ALTER TABLE notification_templates FORCE ROW LEVEL SECURITY;

-- Prove the bracket closed. A migration that left a table unprotected would be
-- a silent cross-tenant hole, so it fails here rather than shipping.
DO $$
BEGIN
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'notification_templates'::regclass) THEN
    RAISE EXCEPTION 'notification_templates was left without FORCE ROW LEVEL SECURITY';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM notification_templates WHERE tenant_id IS NULL AND key = 'appointment_reminder') THEN
    RAISE EXCEPTION 'built-in notification templates were not inserted';
  END IF;
END;
$$;
