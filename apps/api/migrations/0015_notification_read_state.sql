-- =============================================================================
-- 0015  In-app notifications need a read state
-- -----------------------------------------------------------------------------
-- `status` on notifications tracks DELIVERY — queued, sent, failed, bounced —
-- which is the right model for email and SMS, where the system never learns
-- whether a human looked at the message.
--
-- In-app is different: the recipient opens it in this interface, and that is
-- observable. Overloading `status = 'delivered'` to mean "read" would conflate
-- two genuinely different facts and break the worker's retry logic, which keys
-- off exactly those values. So reading gets its own column.
--
-- The index is partial on unread, because the only query that runs on every
-- page load is "how many has this user not read yet", and it should not scan
-- a year of delivered notifications to answer it.
-- =============================================================================

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at timestamptz;

COMMENT ON COLUMN notifications.read_at IS
  'When the recipient opened this in the interface. Null for unread, and always null for channels where being read is not observable (email, SMS).';

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (tenant_id, user_id, created_at DESC)
  WHERE channel = 'in_app' AND read_at IS NULL;
