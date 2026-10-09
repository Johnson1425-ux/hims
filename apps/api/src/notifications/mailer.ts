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

/**
 * A refusal that will clear on its own, given time.
 *
 * NOT EVERY 5xx IS FINAL, which is the trap. Gmail answers a full daily quota
 * with `550 5.4.5 Daily user sending quota exceeded` — a permanent-looking
 * code for a condition that clears in about a day. Treating it as final would
 * drop every queued invoice on the floor the moment the cap was reached.
 *
 * Retrying it hard is the other way to get this wrong: continued attempts
 * against an exhausted quota can extend the lockout. So these are deferred by
 * hours rather than minutes, and they do not count against the row's attempt
 * budget — the message is not failing, it is waiting its turn.
 */
export class TransientDeliveryError extends Error {
  readonly transient = true;

  constructor(
    message: string,
    readonly retryAfterMinutes: number,
  ) {
    super(message);
    this.name = 'TransientDeliveryError';
  }
}

export function transientRetryMinutes(error: unknown): number | null {
  return error instanceof TransientDeliveryError ? error.retryAfterMinutes : null;
}

/**
 * 5xx codes and phrasings that mean "not now" rather than "not ever".
 *
 * Matched on the text as well as the code because the enhanced status is the
 * part that carries the meaning — 5.4.5 is a quota, 5.1.1 is a mailbox that
 * does not exist — and not every server sends one.
 */
const TRANSIENT_5XX = /\b5\.4\.5\b|quota|rate limit|too many|try again|throttl|temporarily|service unavailable|busy/i;

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
    const message = (error as Error).message ?? '';

    if (typeof code === 'number' && code >= 500 && code < 600) {
      if (TRANSIENT_5XX.test(message)) {
        // Two hours, not minutes: a daily quota resets on a 24-hour window,
        // and hammering it is what prolongs the block.
        throw new TransientDeliveryError(
          `the receiving server is refusing for now (${code}): ${message}`,
          120,
        );
      }

      throw new PermanentDeliveryError(
        `the receiving server refused this permanently (${code}): ${message}`,
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
