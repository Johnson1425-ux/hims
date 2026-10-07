/**
 * Create the first console operator.
 *
 * The chicken-and-egg problem: operators are invited by other operators, and
 * on a fresh deployment there are none. Something outside the console has to
 * mint the first one, and the only safe place for that is a command run by
 * whoever already has shell and database access — a person who could create
 * the row by hand anyway, so this grants no authority they did not have.
 *
 * It deliberately does NOT set a password. It prints an invitation link, the
 * operator chooses their own credential, and nobody — including whoever ran
 * this — ever knows it. An operator account whose password was typed by
 * someone else is an account whose actions cannot be attributed, and every
 * action this console takes crosses a tenant boundary.
 *
 * Refuses to run twice: once an owner exists, further operators are invited
 * from inside the console, where the invitation is audited.
 *
 *   pnpm platform:bootstrap -- --email ops@vendor.example --name "Ada Lovelace"
 */
import { Client } from 'pg';
import { loadEnv } from '../config/load-env.js';
import { randomToken, sha256 } from '../security/crypto.js';

loadEnv();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const email = arg('email');
  const fullName = arg('name');

  if (!email || !fullName) {
    fail('Usage: pnpm platform:bootstrap -- --email <address> --name "<full name>"');
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fail(`"${email}" does not look like an email address.`);
  }

  const connectionString = process.env.DATABASE_PLATFORM_URL;
  if (!connectionString) {
    fail(
      'DATABASE_PLATFORM_URL is not set.\n' +
        'The console runs on the BYPASSRLS role (hims_platform). Set it, and\n' +
        'JWT_PLATFORM_SECRET, before bootstrapping — see .env.example.',
    );
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const { rows: owners } = await client.query<{ email: string }>(
      `SELECT email FROM platform_users WHERE is_owner AND status <> 'suspended'`,
    );

    if (owners.length > 0) {
      fail(
        `A console owner already exists (${owners.map((o) => o.email).join(', ')}).\n` +
          'Invite further operators from inside the console, where it is audited.',
      );
    }

    const token = randomToken(32);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO platform_users (email, full_name, is_owner, status,
                                   invite_token_hash, invite_expires_at)
       VALUES ($1, $2, true, 'invited', $3, now() + interval '3 days')
       RETURNING id`,
      [email, fullName, sha256(token)],
    );

    const base = process.env.WEB_BASE_URL ?? 'http://localhost:3000';

    process.stdout.write(
      [
        '',
        'Console owner created.',
        '',
        `  operator  ${fullName} <${email}>`,
        `  id        ${rows[0]!.id}`,
        '',
        '  Open this to choose a password. It is valid for three days and can be used once:',
        '',
        `  ${base}/platform/accept-invite?token=${token}`,
        '',
        '  This link is not stored anywhere and is not recoverable. Re-run with the row',
        '  deleted if it is lost.',
        '',
      ].join('\n'),
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
