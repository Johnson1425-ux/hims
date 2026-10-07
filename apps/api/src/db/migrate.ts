/**
 * Migration runner.
 *
 * Plain, ordered SQL files with a checksum ledger. No DSL and no down-migrations:
 * on a database holding patient records, a scripted rollback that drops a column
 * is how data is lost. Reversals are written as new forward migrations, reviewed
 * like any other change.
 *
 * Usage:
 *   pnpm db:migrate        apply everything pending
 *   pnpm db:status         show applied vs pending
 *   pnpm db:verify         re-check checksums of applied migrations
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

interface MigrationFile {
  version: string;
  name: string;
  path: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const entries = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort(); // Zero-padded numeric prefixes make lexical order the right order.

  return Promise.all(
    entries.map(async (file) => {
      const path = join(MIGRATIONS_DIR, file);
      const sql = await readFile(path, 'utf8');
      const match = /^(\d+)_(.+)\.sql$/.exec(file);

      if (!match?.[1] || !match[2]) {
        throw new Error(`migration filename must be <number>_<name>.sql, got "${file}"`);
      }

      return {
        version: match[1],
        name: match[2],
        path,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}

/**
 * Migrations need table ownership, so they connect as a different, more
 * privileged role than the API. Keeping the two URLs separate means a
 * compromised API process cannot ALTER the schema.
 */
function connect(): Client {
  const connectionString = env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL;
  return new Client({
    connectionString,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    application_name: 'hims-migrate',
  });
}

async function ensureLedger(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL
    )
  `);
}

interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
}

async function fetchApplied(client: Client): Promise<Map<string, AppliedRow>> {
  const { rows } = await client.query<AppliedRow>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.map((r) => [r.version, r]));
}

async function up(): Promise<void> {
  const client = connect();
  await client.connect();

  try {
    // Serialise concurrent deploys: whoever loses the lock waits, then finds
    // nothing pending. Without this, two instances starting together both try
    // to create the same table.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['hims.migrations']);
    await ensureLedger(client);

    const files = await loadMigrations();
    const applied = await fetchApplied(client);

    // Refuse to proceed if an already-applied file has been edited: the
    // database no longer matches the repository, and guessing which is right
    // is not the runner's job.
    for (const file of files) {
      const record = applied.get(file.version);
      if (record && record.checksum !== file.checksum) {
        throw new Error(
          `migration ${file.version}_${file.name} was modified after being applied ` +
            `(recorded ${record.checksum.slice(0, 12)}, file ${file.checksum.slice(0, 12)}). ` +
            'Write a new migration instead of editing a released one.',
        );
      }
    }

    const pending = files.filter((f) => !applied.has(f.version));

    if (pending.length === 0) {
      logger.info({ applied: applied.size }, 'database is up to date');
      return;
    }

    logger.info({ pending: pending.map((p) => `${p.version}_${p.name}`) }, 'applying migrations');

    for (const file of pending) {
      const startedAt = Date.now();

      // Each migration is its own transaction: a failure leaves the ones
      // before it applied and recorded, so a re-run resumes rather than
      // starting over.
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        const durationMs = Date.now() - startedAt;

        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
           VALUES ($1, $2, $3, $4)`,
          [file.version, file.name, file.checksum, durationMs],
        );
        await client.query('COMMIT');

        logger.info({ version: file.version, name: file.name, durationMs }, 'migration applied');
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error(
          { version: file.version, name: file.name, err: error },
          'migration failed; database left at the previous version',
        );
        throw error;
      }
    }

    logger.info({ count: pending.length }, 'migrations complete');
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['hims.migrations']).catch(() => undefined);
    await client.end();
  }
}

async function status(): Promise<void> {
  const client = connect();
  await client.connect();

  try {
    await ensureLedger(client);
    const files = await loadMigrations();
    const applied = await fetchApplied(client);

    process.stdout.write('\n  version  status    name\n');
    process.stdout.write('  -------  --------  ------------------------------------\n');

    for (const file of files) {
      const record = applied.get(file.version);
      const state = !record
        ? 'PENDING '
        : record.checksum === file.checksum
          ? 'applied '
          : 'MODIFIED';
      process.stdout.write(`  ${file.version}     ${state}  ${file.name}\n`);
    }

    const pendingCount = files.filter((f) => !applied.has(f.version)).length;
    process.stdout.write(`\n  ${files.length} migration(s), ${pendingCount} pending\n\n`);
  } finally {
    await client.end();
  }
}

async function verify(): Promise<void> {
  const client = connect();
  await client.connect();

  try {
    await ensureLedger(client);
    const files = await loadMigrations();
    const applied = await fetchApplied(client);
    const problems: string[] = [];

    for (const [version, record] of applied) {
      const file = files.find((f) => f.version === version);
      if (!file) {
        problems.push(`${version}_${record.name}: applied, but the file is missing from the repository`);
      } else if (file.checksum !== record.checksum) {
        problems.push(`${version}_${record.name}: file no longer matches what was applied`);
      }
    }

    // Independently confirm the two structural guarantees the schema rests on.
    const { rows: rlsGaps } = await client.query<{ relname: string }>(`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
         AND NOT c.relrowsecurity
       ORDER BY 1
    `);
    for (const row of rlsGaps) {
      problems.push(`${row.relname}: tenant-scoped table with row-level security disabled`);
    }

    /*
     * The audit chain, on a connection that can actually see it.
     *
     * This ran on the migration connection, and `audit_events` is FORCE'd
     * under row-level security — so with no tenant context it walked ZERO
     * rows and reported the chain unbroken every single time, including over
     * a trail that was genuinely forked. The function now refuses to pass
     * vacuously, which means it must be given a role that sees everything:
     * `hims_platform`, via DATABASE_PLATFORM_URL.
     *
     * Where that is not configured the check is reported as SKIPPED. Saying
     * "not checked" is the only honest option; saying "unbroken" is what this
     * code used to do.
     */
    const checks = ['checksums match', 'row-level security intact'];

    if (process.env.DATABASE_PLATFORM_URL) {
      const auditClient = new Client({ connectionString: process.env.DATABASE_PLATFORM_URL });
      await auditClient.connect();

      try {
        const { rows: chainBreaks } = await auditClient.query<{ broken_at_id: string }>(
          'SELECT broken_at_id FROM hims_util.verify_audit_chain()',
        );
        for (const row of chainBreaks) {
          problems.push(`audit_events: hash chain broken at row ${row.broken_at_id}`);
        }
        checks.push('audit chain unbroken');
      } catch (error) {
        problems.push(
          `audit_events: the hash chain could not be verified (${(error as Error).message})`,
        );
      } finally {
        await auditClient.end();
      }
    } else {
      logger.warn(
        'audit chain NOT CHECKED: set DATABASE_PLATFORM_URL to a hims_platform connection. ' +
          'The migration role cannot see audit_events through row-level security.',
      );
      checks.push('audit chain NOT CHECKED');
    }

    if (problems.length > 0) {
      logger.error({ problems }, 'verification failed');
      process.exitCode = 1;
      return;
    }

    logger.info({ migrations: applied.size }, `verified: ${checks.join(', ')}`);
  } finally {
    await client.end();
  }
}

const command = process.argv[2] ?? 'up';

const commands: Record<string, () => Promise<void>> = { up, status, verify };
const handler = commands[command];

if (!handler) {
  process.stderr.write(`unknown command "${command}". Use: up | status | verify\n`);
  process.exit(1);
}

handler().catch((error) => {
  logger.error({ err: error }, `migrate ${command} failed`);
  process.exit(1);
});
