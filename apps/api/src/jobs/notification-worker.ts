/**
 * Notification worker.
 *
 * Drains the `notifications` outbox written by the API in the same transaction
 * as the business change. The transactional-outbox pattern is what keeps
 * "appointment booked" and "confirmation sent" from diverging when the SMS
 * gateway is down.
 *
 * Three rules this worker exists to enforce:
 *
 *   1. NO PHI IN AN SMS. A text message traverses carriers in the clear and
 *      lands on a lock screen. A reminder may say when and where; it may not
 *      say why. Templates must be marked `phi_safe` to render over SMS at all.
 *   2. Claim rows with FOR UPDATE SKIP LOCKED, so several workers can run
 *      without sending the same reminder twice.
 *   3. Exponential backoff on failure, with a cap on attempts, so a
 *      permanently bad address does not spin forever.
 */
import { withoutTenantIsolation, type Queryable } from '../db/pool.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { createFieldCipher } from '../security/crypto.js';
import { renderNotificationHtml } from '../notifications/email-content.js';
import {
  closeMailTransport,
  isPermanentDeliveryError,
  mailConfigured,
  sendEmail,
  transientRetryMinutes,
  verifyMailTransport,
} from '../notifications/mailer.js';

const BATCH_SIZE = 50;

interface NotificationRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  patient_id: string | null;
  channel: string;
  template_key: string | null;
  destination_encrypted: Buffer | null;
  subject: string | null;
  body: string | null;
  payload: Record<string, unknown>;
  category: string;
  attempts: number;
  max_attempts: number;
}

/**
 * Resolve where a notification should go.
 *
 * The destination may be stamped on the row, or derived from the recipient's
 * record. Either way it is decrypted here, inside the worker, and never logged.
 */
async function resolveDestination(
  db: Queryable,
  row: NotificationRow,
): Promise<string | null> {
  const { rows: keyRows } = await db.query<{ dek_wrapped: Buffer }>(
    'SELECT dek_wrapped FROM tenants WHERE id = $1',
    [row.tenant_id],
  );

  if (!keyRows[0]) return null;
  const cipher = createFieldCipher(row.tenant_id, keyRows[0].dek_wrapped);

  if (row.destination_encrypted) {
    return cipher.decrypt(row.destination_encrypted, {
      table: 'notifications',
      column: 'destination_encrypted',
      recordId: row.id,
    });
  }

  const wantsEmail = row.channel === 'email';

  if (row.patient_id) {
    const { rows } = await db.query<{ email_encrypted: Buffer | null; phone_encrypted: Buffer | null }>(
      'SELECT email_encrypted, phone_encrypted FROM patients WHERE id = $1',
      [row.patient_id],
    );
    if (!rows[0]) return null;

    const column = wantsEmail ? 'email_encrypted' : 'phone_encrypted';
    return cipher.decrypt(rows[0][column], {
      table: 'patients',
      column,
      recordId: row.patient_id,
    });
  }

  if (row.user_id) {
    if (wantsEmail) {
      const { rows } = await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [
        row.user_id,
      ]);
      return rows[0]?.email ?? null;
    }

    const { rows } = await db.query<{ phone_encrypted: Buffer | null }>(
      'SELECT phone_encrypted FROM users WHERE id = $1',
      [row.user_id],
    );
    return cipher.decrypt(rows[0]?.phone_encrypted ?? null, {
      table: 'users',
      column: 'phone_encrypted',
      recordId: row.user_id,
    });
  }

  return null;
}

/**
 * Render a template.
 *
 * `phi_safe` is enforced, not advisory: an SMS template that has not been
 * reviewed and marked safe is refused rather than sent with whatever the
 * payload happens to contain.
 */
async function render(
  db: Queryable,
  row: NotificationRow,
): Promise<{ subject: string | null; body: string; isTenantOverride: boolean } | null> {
  if (row.body) {
    return { subject: row.subject, body: row.body, isTenantOverride: true };
  }
  if (!row.template_key) return null;

  const { rows } = await db.query<{
    subject: string | null;
    body: string;
    phi_safe: boolean;
    tenant_id: string | null;
  }>(
    `SELECT subject, body, phi_safe, tenant_id
       FROM notification_templates
      WHERE key = $1 AND channel = $2 AND is_active
        AND (tenant_id = $3 OR tenant_id IS NULL)
      ORDER BY tenant_id NULLS LAST
      LIMIT 1`,
    [row.template_key, row.channel, row.tenant_id],
  );

  const template = rows[0];
  if (!template) {
    logger.error(
      { templateKey: row.template_key, channel: row.channel },
      'no template found; notification cannot be rendered',
    );
    return null;
  }

  if ((row.channel === 'sms' || row.channel === 'voice') && !template.phi_safe) {
    logger.error(
      { templateKey: row.template_key, channel: row.channel },
      'refusing to send: template is not marked PHI-safe for an unencrypted channel',
    );
    return null;
  }

  // Deliberately minimal interpolation: {{key}} from the payload only, with no
  // expression evaluation, so a template cannot reach into arbitrary state.
  const interpolate = (text: string): string =>
    text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const value = row.payload[key];
      return value === undefined || value === null ? '' : String(value);
    });

  return {
    subject: template.subject ? interpolate(template.subject) : null,
    body: interpolate(template.body),
    isTenantOverride: template.tenant_id !== null,
  };
}

/**
 * The hospital's own name, for the top of its own emails.
 *
 * Cached for the life of the process: it changes about once, and a batch of
 * fifty reminders for one hospital should not be fifty lookups.
 */
const tenantNames = new Map<string, string>();

async function tenantName(db: Queryable, tenantId: string): Promise<string> {
  const cached = tenantNames.get(tenantId);
  if (cached !== undefined) return cached;

  const { rows } = await db.query<{ display_name: string }>(
    'SELECT display_name FROM tenants WHERE id = $1',
    [tenantId],
  );

  const name = rows[0]?.display_name ?? '';
  tenantNames.set(tenantId, name);
  return name;
}

/** Dispatch through the configured provider, or log in development. */
async function deliver(
  channel: string,
  destination: string,
  content: { subject: string | null; body: string; html?: string },
): Promise<{ providerMessageId: string; provider: string }> {
  if (channel === 'email' && mailConfigured()) {
    const messageId = await sendEmail({
      to: destination,
      // A subject is required by the templates that have one; the few that do
      // not are in-app rows, which never reach here. The fallback exists so a
      // misconfigured template cannot produce a blank-subject email.
      subject: content.subject ?? 'A message from your hospital system',
      text: content.body,
      html: content.html,
    });

    return { providerMessageId: messageId, provider: 'smtp' };
  }

  if (channel === 'sms' && env.SMS_PROVIDER === 'twilio') {
    // INTEGRATION POINT: Twilio REST call goes here.
    throw new Error('Twilio transport is configured but not yet wired');
  }

  if (channel === 'in_app') {
    // Nothing to send: the row itself is the notification, and the client
    // reads it from the API.
    return { providerMessageId: 'in-app', provider: 'internal' };
  }

  // No provider configured. Log the fact of the send, never the destination
  // or the body, so a development run cannot leak a real patient's details
  // into a log file.
  logger.info(
    { channel, destinationLength: destination.length, hasSubject: Boolean(content.subject) },
    'notification not sent: no provider configured for this channel (development mode)',
  );

  return { providerMessageId: `dev-${Date.now()}`, provider: 'development-sink' };
}

/**
 * Turn due appointment reminders into outbox rows.
 *
 * Kept separate from the send so that a reminder plan can be cancelled by a
 * reschedule right up to the moment it materialises.
 */
async function materialiseAppointmentReminders(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `
    WITH due AS (
      SELECT r.id, r.tenant_id, r.appointment_id, r.channel, a.patient_id, a.starts_at,
             sp.display_name AS provider_name,
             COALESCE(f.name, t.display_name) AS location_name,
             COALESCE(f.timezone, t.timezone, 'UTC') AS tz
        FROM appointment_reminders r
        JOIN appointments a ON a.id = r.appointment_id
        JOIN staff_profiles sp ON sp.id = a.provider_id
        JOIN tenants t ON t.id = r.tenant_id
        LEFT JOIN facilities f ON f.id = a.facility_id
       WHERE r.status = 'pending'
         AND r.scheduled_for <= now()
         -- A cancelled or completed appointment needs no reminder.
         AND a.status IN ('scheduled','confirmed')
       ORDER BY r.scheduled_for
       LIMIT 200
       FOR UPDATE OF r SKIP LOCKED
    ),
    queued AS (
      INSERT INTO notifications (tenant_id, patient_id, channel, template_key, category,
                                 priority, payload, related_kind, related_id, dedupe_key)
      SELECT d.tenant_id, d.patient_id, d.channel, 'appointment_reminder', 'appointment', 3,
             -- Only non-clinical facts: when, where, with whom. Never the
             -- reason for the visit.
             jsonb_build_object(
               'appointmentDate', to_char(d.starts_at AT TIME ZONE d.tz, 'FMDay DD FMMonth'),
               'appointmentTime', to_char(d.starts_at AT TIME ZONE d.tz, 'HH12:MIam'),
               'providerName', d.provider_name,
               'locationName', d.location_name
             ),
             'appointment', d.appointment_id,
             'reminder:' || d.id
        FROM due d
      ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL
         DO NOTHING
      RETURNING id
    )
    UPDATE appointment_reminders r
       SET status = 'sent', sent_at = now(), attempts = attempts + 1
     WHERE r.id IN (SELECT id FROM due)
    RETURNING r.id
    `,
  );

  return rows.length;
}

async function processBatch(): Promise<{ sent: number; failed: number; materialised: number }> {
  return withoutTenantIsolation(
    'notification worker drains every tenant’s outbox',
    async (db) => {
      const materialised = await materialiseAppointmentReminders(db);

      // SKIP LOCKED lets several worker replicas share the queue without
      // sending anything twice.
      const { rows } = await db.query<NotificationRow>(
        `
        SELECT id, tenant_id, user_id, patient_id, channel, template_key,
               destination_encrypted, subject, body, payload, category, attempts, max_attempts
          FROM notifications
         WHERE status = 'queued'
           AND scheduled_for <= now()
         ORDER BY priority, scheduled_for
         LIMIT ${BATCH_SIZE}
         FOR UPDATE SKIP LOCKED
        `,
      );

      let sent = 0;
      let failed = 0;

      for (const row of rows) {
        await db.query(`UPDATE notifications SET status = 'sending' WHERE id = $1`, [row.id]);

        try {
          const content = await render(db, row);
          if (!content) {
            // Unrenderable: suppress rather than retry, because nothing about
            // the next attempt will be different.
            await db.query(
              `UPDATE notifications
                  SET status = 'suppressed', failure_reason = 'template missing or not PHI-safe'
                WHERE id = $1`,
              [row.id],
            );
            failed += 1;
            continue;
          }

          const destination = row.channel === 'in_app' ? 'in-app' : await resolveDestination(db, row);
          if (!destination) {
            await db.query(
              `UPDATE notifications
                  SET status = 'suppressed', failure_reason = 'no contact detail on file'
                WHERE id = $1`,
              [row.id],
            );
            failed += 1;
            continue;
          }

          /*
           * The HTML is built from the PAYLOAD, not from the rendered text,
           * so each value can be escaped on the way into markup and the
           * signed download URL can go in a button's href instead of being
           * read out mid-sentence. The plain text still goes in the same
           * message as the alternative part — for clients that refuse HTML,
           * for anyone who prefers it, and because a mail with no text part
           * scores worse with every spam filter there is.
           */
          const html =
            row.channel === 'email'
              ? renderNotificationHtml({
                  templateKey: row.template_key,
                  payload: row.payload,
                  subject: content.subject,
                  text: content.body,
                  tenantName: await tenantName(db, row.tenant_id),
                  vendorName: env.INVOICE_VENDOR_NAME,
                  vendorAddress: env.INVOICE_VENDOR_ADDRESS,
                  isTenantOverride: content.isTenantOverride,
                })
              : undefined;

          const result = await deliver(row.channel, destination, { ...content, html });

          await db.query(
            `UPDATE notifications
                SET status = 'sent', sent_at = now(), attempts = attempts + 1,
                    provider = $2, provider_message_id = $3,
                    subject = COALESCE(subject, $4), body = COALESCE(body, $5)
              WHERE id = $1`,
            [row.id, result.provider, result.providerMessageId, content.subject, content.body],
          );

          sent += 1;
        } catch (error) {
          /*
           * DEFERRED, NOT FAILED. Some 5xx replies mean "not now" rather than
           * "not ever" — Gmail answers an exhausted daily quota with
           * `550 5.4.5`, which clears in about a day. The message has not
           * failed, so it does not spend an attempt; it is pushed out by
           * hours and tried again, because retrying hard against a quota is
           * what extends the lockout.
           */
          const deferFor = transientRetryMinutes(error);

          if (deferFor !== null) {
            await db.query(
              `UPDATE notifications
                  SET status = 'queued',
                      scheduled_for = now() + make_interval(mins => $2),
                      failure_reason = $3
                WHERE id = $1`,
              [row.id, deferFor, error instanceof Error ? error.message.slice(0, 500) : 'deferred'],
            );

            failed += 1;
            logger.warn(
              { notificationId: row.id, channel: row.channel, deferMinutes: deferFor },
              'notification deferred; the receiving server is refusing for now',
            );
            continue;
          }

          const attempts = row.attempts + 1;

          // A 5xx from the receiving server is otherwise a verdict, not a
          // hiccup: the mailbox does not exist or the message was rejected
          // outright. Retrying it three more times on a backoff achieves
          // nothing and tells the receiving side this sender keeps mailing
          // addresses that bounce.
          const permanent = isPermanentDeliveryError(error);
          const exhausted = permanent || attempts >= row.max_attempts;

          // Exponential backoff: 1, 2, 4, 8 minutes...
          const backoffMinutes = Math.min(2 ** attempts, 60);

          await db.query(
            `UPDATE notifications
                SET status = $2,
                    attempts = $3,
                    failure_reason = $4,
                    next_attempt_at = CASE WHEN $2 = 'failed'
                      THEN now() + make_interval(mins => $5) END
              WHERE id = $1`,
            [
              row.id,
              exhausted ? 'failed' : 'queued',
              attempts,
              error instanceof Error ? error.message.slice(0, 500) : 'unknown error',
              backoffMinutes,
            ],
          );

          // Re-queue with the backoff applied.
          if (!exhausted) {
            await db.query(
              `UPDATE notifications
                  SET scheduled_for = now() + make_interval(mins => $2)
                WHERE id = $1`,
              [row.id, backoffMinutes],
            );
          }

          failed += 1;
          logger.warn(
            { notificationId: row.id, channel: row.channel, attempts, exhausted, permanent },
            permanent
              ? 'notification refused permanently; not retrying'
              : 'notification delivery failed',
          );
        }
      }

      return { sent, failed, materialised };
    },
  );
}

let running = true;

async function loop(): Promise<void> {
  // Before the first batch, so a wrong host or a rejected password is one
  // loud line at startup rather than a thousand identical failures found
  // days later.
  await verifyMailTransport();

  logger.info(
    { intervalSeconds: env.REMINDER_SCAN_INTERVAL_SECONDS, batchSize: BATCH_SIZE },
    'notification worker started',
  );

  while (running) {
    try {
      const result = await processBatch();

      if (result.sent > 0 || result.failed > 0 || result.materialised > 0) {
        logger.info(result, 'notification batch processed');
      }
    } catch (error) {
      logger.error({ err: error }, 'notification batch failed; will retry');
    }

    await new Promise((resolve) =>
      setTimeout(resolve, env.REMINDER_SCAN_INTERVAL_SECONDS * 1000),
    );
  }
}

process.on('SIGTERM', () => {
  logger.info('notification worker stopping');
  running = false;
  // The pooled SMTP connections hold the event loop open otherwise.
  closeMailTransport();
});

void loop();
