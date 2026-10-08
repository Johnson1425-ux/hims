/**
 * A local SMTP server that accepts everything and prints it.
 *
 * Development needs an answer to "did that email actually go, and what did it
 * say". Without one the choice is between pointing a dev machine at a real
 * relay — which eventually mails a real person by accident — and leaving
 * MAIL_PROVIDER empty, which exercises none of the send path: no transport,
 * no TLS negotiation, no address resolution, no bounce handling.
 *
 *   pnpm mail:sink                      prints each message to the terminal
 *   pnpm mail:sink -- --out ./mail      also writes each one as .json
 *   pnpm mail:sink -- --reject          refuses everything with a hard 550
 *
 * Then, in .env:
 *
 *   MAIL_PROVIDER=smtp
 *   SMTP_HOST=127.0.0.1
 *   SMTP_PORT=2525
 *   SMTP_INSECURE=true
 *
 * `--reject` is how you exercise the failure path on purpose: a 5xx is
 * treated as final and the notification is failed rather than retried, which
 * is a branch that is otherwise only reached in production by a real bounce.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const PORT = Number(arg('port') ?? 2525);
const OUT = arg('out');
const REJECT = process.argv.includes('--reject');

if (OUT) mkdirSync(OUT, { recursive: true });

let count = 0;

const server = new SMTPServer({
  // No credentials: this is a sink on a loopback interface, and requiring a
  // password would only mean another thing to configure wrongly.
  authOptional: true,
  // Nothing here has a certificate, and the API's SMTP_INSECURE flag is the
  // matching half of this.
  disabledCommands: ['STARTTLS'],

  onRcptTo(address, _session, callback) {
    if (!REJECT) return callback();

    const error = Object.assign(
      new Error(`550 5.1.1 <${address.address}>: Recipient address rejected: User unknown`),
      { responseCode: 550 },
    );
    process.stdout.write(`refused  ${address.address}\n`);
    callback(error);
  },

  onData(stream, _session, callback) {
    simpleParser(stream)
      .then((mail) => {
        count += 1;

        const record = {
          from: mail.from?.text,
          replyTo: mail.replyTo?.text ?? null,
          to: mail.to && 'text' in mail.to ? mail.to.text : undefined,
          subject: mail.subject,
          text: mail.text,
          messageId: mail.messageId,
        };

        process.stdout.write(
          `\n${'─'.repeat(72)}\n` +
            `#${count}  to ${record.to}\n` +
            `    ${record.subject}\n` +
            `${'─'.repeat(72)}\n${record.text ?? ''}\n`,
        );

        if (OUT) {
          const name = `${OUT}/${String(count).padStart(3, '0')}.json`;
          writeFileSync(name, JSON.stringify(record, null, 2));
          process.stdout.write(`    (written to ${name})\n`);
        }

        callback();
      })
      .catch(callback);
  },
});

// Without this a port already in use emits an unhandled 'error' and the
// process dies with a stack trace, or worse sits there having bound nothing.
server.on('error', (error: NodeJS.ErrnoException) => {
  process.stderr.write(
    error.code === 'EADDRINUSE'
      ? `port ${PORT} is already in use — another sink is probably still running\n`
      : `mail sink error: ${error.message}\n`,
  );
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `mail sink listening on 127.0.0.1:${PORT}` +
      (REJECT ? ' — refusing everything with 550\n' : '\n') +
      `set SMTP_HOST=127.0.0.1 SMTP_PORT=${PORT} SMTP_INSECURE=true MAIL_PROVIDER=smtp\n`,
  );
});
