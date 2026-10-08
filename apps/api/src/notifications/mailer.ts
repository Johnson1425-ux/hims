/**
 * SMTP transport.
 *
 * Kept apart from the worker because the transport is a long-lived pooled
 * connection, not a per-message object: building one per send would open a
 * TCP connection and run a TLS handshake and an AUTH exchange for every
 * email, which most providers rate-limit long before the volume justifies it.
 *
 * PROVIDER-AGNOSTIC ON PURPOSE. Everything is driven by SMTP_HOST/PORT/USER/
 * PASSWORD, so SES, Mailgun, Postmark, Resend, a hospital's own Exchange
 * relay, or MailHog on a laptop all work without a code change. There is no
 * vendor SDK here to pin the deployment to one of them.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * A refusal the receiving server will repeat forever.
 *
 * A 5xx is a verdict, not a hiccup: the mailbox does not exist, the domain
 * does not resolve, the message was rejected outright. Retrying it four times
 * on a backoff wastes the queue and teaches the receiving side that this
 * sender keeps mailing addresses that bounce, which is how a domain's
 * reputation goes. The worker fails these immediately instead.
 */
export class PermanentDeliveryError extends Error {
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = 'PermanentDeliveryError';
  }
}

export function isPermanentDeliveryError(error: unknown): boolean {
  return error instanceof PermanentDeliveryError;
}

let transport: Transporter | null = null;

export function mailConfigured(): boolean {
  return env.MAIL_PROVIDER === 'smtp' && Boolean(env.SMTP_HOST);
}

/**
 * Build the transport once, on first use.
 *
 * `secure` is derived from the port rather than configured separately,
 * because the two cannot disagree without failing: 465 is implicit TLS and
 * everything else — 587, 2525, 25 — is cleartext upgraded by STARTTLS. Asking
 * an operator to set both is asking them to get it wrong.
 */
function getTransport(): Transporter {
  if (transport) return transport;

  const port = env.SMTP_PORT ?? 587;

  transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    // STARTTLS REQUIRED on the cleartext ports, not opportunistic. Without
    // this nodemailer will send in the clear if the server does not advertise
    // STARTTLS, and these messages carry invoices, people's names and
    // password-setting links. Turned off only for an explicitly insecure
    // local sink, which is the one case where there is no TLS to require.
    requireTLS: port !== 465 && !env.SMTP_INSECURE,
    ignoreTLS: env.SMTP_INSECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return transport;
}

/**
 * Prove the configuration at boot rather than per message.
 *
 * A wrong host or a rejected password should be one loud line at startup,
 * not a thousand identical failures discovered days later in a column of the
 * notifications table nobody reads. It never throws: a mail server that is
 * briefly unreachable must not stop the worker starting and draining in-app
 * notifications, which need no SMTP at all.
 */
export async function verifyMailTransport(): Promise<boolean> {
  if (!mailConfigured()) {
    logger.info(
      { mailProvider: env.MAIL_PROVIDER || 'none' },
      'no SMTP transport configured; email notifications will be logged, not sent',
    );
    return false;
  }

  try {
    await getTransport().verify();
    logger.info(
      { host: env.SMTP_HOST, port: env.SMTP_PORT ?? 587, from: env.MAIL_FROM },
      'SMTP transport verified',
    );
    return true;
  } catch (error) {
    logger.error(
      { err: error, host: env.SMTP_HOST, port: env.SMTP_PORT ?? 587 },
      'SMTP transport could NOT be verified; email will fail until this is fixed',
    );
    return false;
  }
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  text: string;
}): Promise<string> {
  try {
    const info = await getTransport().sendMail({
      from: env.MAIL_FROM,
      // Several of these messages end "reply to this message and we will look
      // into it". A no-reply From makes that a lie, so a reply-to is set when
      // one is configured.
      replyTo: env.MAIL_REPLY_TO || undefined,
      to: args.to,
      subject: args.subject,
      text: args.text,
    });

    return info.messageId;
  } catch (error) {
    const code = (error as { responseCode?: number }).responseCode;

    if (typeof code === 'number' && code >= 500 && code < 600) {
      throw new PermanentDeliveryError(
        `the receiving server refused this permanently (${code}): ${(error as Error).message}`,
      );
    }

    throw error;
  }
}

/** Closes the pool so a worker can shut down without hanging on open sockets. */
export function closeMailTransport(): void {
  transport?.close();
  transport = null;
}
