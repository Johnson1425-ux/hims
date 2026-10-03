/**
 * Create the local database and its roles.
 *
 * Deliberately standalone: it does NOT import config/env.ts, because that
 * module validates encryption keys and JWT secrets and exits if they are
 * missing — which would be backwards here. Creating the database is the step
 * that comes *before* the application is configured.
 *
 * Idempotent: safe to re-run. It creates what is absent and leaves the rest
 * alone, so it can be used to repair a half-made local setup.
 *
 * Why three roles rather than one: the privilege separation is part of the
 * security model, and it is easy to lose if development runs everything as a
 * superuser. An API connected as a superuser silently bypasses every
 * row-level security policy in the schema — the isolation tests would pass
 * while the running system leaked.
 *
 *   hims_owner      owns the schema; migrations connect as this
 *   hims_app        the API; NO bypassrls, so RLS applies
 *   hims_platform   bypassrls, for break-glass support and cross-tenant jobs
 *   hims_analytics  reads reporting views only
 *
 * Usage:
 *   pnpm db:create                 # uses DATABASE_ADMIN_URL, or a sensible default
 *   pnpm db:create -- --drop       # drop and recreate (local only; refuses if not)
 */
import { Client } from 'pg';
import { loadEnv } from '../config/load-env.js';

const ENV_FILES = loadEnv();

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres';

const DB_NAME = process.env.DATABASE_NAME ?? 'hims';
const DEV_PASSWORD = process.env.DATABASE_DEV_PASSWORD ?? 'dev-only-password';

const ROLES = [
  { name: 'hims_owner', attrs: '', note: 'owns the schema; migrations run as this' },
  { name: 'hims_app', attrs: '', note: 'the API; no bypassrls, so RLS applies' },
  { name: 'hims_platform', attrs: 'BYPASSRLS', note: 'cross-tenant support and batch jobs' },
  { name: 'hims_analytics', attrs: '', note: 'reporting views only' },
] as const;

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** Quote an identifier for interpolation; role and database names are not parameterisable. */
function ident(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`refusing to use "${value}" as an identifier`);
  }
  return `"${value}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'postgres';
  } catch {
    return false;
  }
}

/**
 * Detect a data volume left over from an earlier version of the compose file.
 *
 * That file once set `POSTGRES_USER: hims_owner`, which makes hims_owner the
 * cluster SUPERUSER. Because `POSTGRES_USER` is only honoured when the volume
 * is first initialised, pulling the corrected file recreates the container but
 * leaves that cluster — and its superuser — in place, so connecting as
 * `postgres` fails with an error that reads identically to a wrong password.
 *
 * Trying exactly one candidate turns "here are two things it might be" into a
 * definite answer. The credential is one this project would itself have
 * created, the host is already known to be local, and nothing proceeds on the
 * result: it is used only to name the cause.
 */
async function probeForStaleVolume(host: string, port: string): Promise<string | null> {
  const candidates = ['hims_owner'];

  for (const candidate of candidates) {
    const probe = new Client({
      host,
      port: Number(port),
      user: candidate,
      password: DEV_PASSWORD,
      database: 'postgres',
      application_name: 'hims-db-create-probe',
      connectionTimeoutMillis: 4000,
    });

    try {
      await probe.connect();
      await probe.end();
      return candidate;
    } catch {
      await probe.end().catch(() => undefined);
    }
  }

  return null;
}

/**
 * Explain a failed connection in terms of what is actually likely to be wrong.
 *
 * PostgreSQL deliberately returns the SAME "password authentication failed"
 * message whether the password is wrong or the role does not exist at all — it
 * will not confirm which, because that would let an attacker enumerate valid
 * usernames. That is correct of PostgreSQL and unhelpful here, so this spells
 * out the two causes that actually produce it during local setup.
 */
async function reportConnectionFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;
  const redacted = ADMIN_URL.replace(/:[^:@]*@/, ':***@');

  let host = 'localhost';
  let port = '5432';
  let user = 'postgres';
  try {
    const url = new URL(ADMIN_URL);
    host = url.hostname || host;
    port = url.port || port;
    user = decodeURIComponent(url.username) || user;
  } catch {
    // Keep the defaults; the URL itself is reported below either way.
  }

  log(`\nCould not connect to PostgreSQL at ${redacted}\n`);
  log(`  ${message}\n`);

  const authFailed = /password authentication failed|role .* does not exist/i.test(message);
  const refused = code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(message);

  if (refused) {
    log(`Nothing is listening on ${host}:${port}.\n`);
    log('  • start the bundled server:');
    log('      docker compose -f infra/docker-compose.yml up -d postgres');
    log('  • or point DATABASE_ADMIN_URL in .env at your own server\n');
    return;
  }

  if (authFailed) {
    log(`Something IS listening on ${host}:${port}, but it rejected the credentials.`);

    // Rather than listing possibilities, find out. The only credential worth
    // probing is the one an EARLIER version of this project's own compose file
    // would have created, so this identifies a stale data volume precisely.
    // Local hosts only, and it reports rather than proceeding.
    const stale = isLocal(ADMIN_URL) ? await probeForStaleVolume(host, port) : null;

    if (stale) {
      log('');
      log(`  DIAGNOSED: the server accepted "${stale}" instead of "${user}".`);
      log('');
      log(`  "${stale}" was the superuser in an EARLIER version of`);
      log('  infra/docker-compose.yml. POSTGRES_USER is read only when the data');
      log('  volume is first initialised, so pulling the updated file recreated');
      log('  the container but left the original cluster — and its original');
      log('  superuser — untouched inside the volume.');
      log('');
      log('  Removing the volume is the fix. `down` alone is not enough:');
      log('');
      log('    docker compose -f infra/docker-compose.yml down -v');
      log('    docker compose -f infra/docker-compose.yml up -d');
      log('    pnpm db:create');
      log('');
      log('  This discards the database, which at this stage holds nothing but');
      log('  seed data. Do NOT instead point DATABASE_ADMIN_URL at');
      log(`  "${stale}": it is a superuser there, and a superuser bypasses`);
      log('  row-level security entirely — tenant isolation would be inert.');
      log('');
      return;
    }

    log('PostgreSQL returns this same message whether the password is wrong or the');
    log(`role "${user}" does not exist, so both are worth checking.\n`);

    log('  1. A container created by an EARLIER version of the compose file.');
    log('     POSTGRES_USER is read only when the data volume is first');
    log('     initialised, so changing it later has no effect until the volume');
    log('     is removed. This is the usual cause after pulling an update:\n');
    log('       docker compose -f infra/docker-compose.yml down -v');
    log('       docker compose -f infra/docker-compose.yml up -d\n');
    log('     To see which superuser the running container actually has:');
    log('       docker exec hims-postgres psql -U postgres -c "\\du"\n');

    log(`  2. A different PostgreSQL already on port ${port}.`);
    log('     Common on Windows and macOS, where the installer registers a');
    log('     service that starts at boot and takes the port before Docker.\n');
    log('       Windows:  netstat -ano | findstr :' + port);
    log('       macOS:    lsof -nP -iTCP:' + port + ' -sTCP:LISTEN');
    log('       Linux:    ss -lptn "sport = :' + port + '"\n');
    log('     Either point DATABASE_ADMIN_URL at that server with its own');
    log('     password, or move the container aside:\n');
    log('       POSTGRES_PORT=5433 docker compose -f infra/docker-compose.yml up -d');
    log('       # then set DATABASE_ADMIN_URL / DATABASE_URL / DATABASE_MIGRATION_URL');
    log('       # in .env to use :5433\n');
    return;
  }

  log('Check that PostgreSQL is running, then either:');
  log('  • start the bundled one:  docker compose -f infra/docker-compose.yml up -d postgres');
  log('  • or point this at yours: set DATABASE_ADMIN_URL in .env\n');
}

async function main(): Promise<void> {
  const drop = process.argv.includes('--drop');

  if (drop && !isLocal(ADMIN_URL)) {
    log('refusing --drop against a non-local host. Check DATABASE_ADMIN_URL.');
    process.exit(1);
  }

  const client = new Client({ connectionString: ADMIN_URL, application_name: 'hims-db-create' });

  try {
    await client.connect();
  } catch (error) {
    await reportConnectionFailure(error);
    process.exit(1);
  }

  try {
    const { rows: version } = await client.query<{ server_version_num: string }>(
      'SHOW server_version_num',
    );
    const major = Math.floor(Number(version[0]!.server_version_num) / 10000);

    // Migration 0008 depends on `security_invoker` views, which arrived in 15.
    // Failing here beats failing halfway through the schema.
    if (major < 15) {
      log(`\nPostgreSQL ${major} is too old. This schema needs 15 or later:`);
      log('  • security_invoker views (15+) stop a view bypassing row-level security');
      log('  • the booking exclusion constraint relies on btree_gist over tstzrange\n');
      process.exit(1);
    }

    log(`\nPostgreSQL ${major} — creating local database\n`);

    // Say which .env files were actually read. Under pnpm the working
    // directory is the package, not the repo root, so "I edited .env and
    // nothing changed" is an easy and confusing mistake to make.
    if (ENV_FILES.loaded.length > 0) {
      const root = ENV_FILES.repoRoot ?? '';
      const shown = ENV_FILES.loaded.map((f) => f.replace(`${root}/`, '').replace(`${root}\\`, ''));
      log(`  config from ${shown.join(', ')}\n`);
    } else {
      log('  no .env file found — using built-in defaults\n');
    }

    // ---- Roles -------------------------------------------------------------
    for (const role of ROLES) {
      const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
        role.name,
      ]);

      if (rowCount) {
        log(`  role ${role.name.padEnd(15)} already exists`);
        continue;
      }

      try {
        await client.query(
          `CREATE ROLE ${ident(role.name)} LOGIN PASSWORD ${literal(DEV_PASSWORD)} ${role.attrs}`,
        );
        log(`  role ${role.name.padEnd(15)} created      (${role.note})`);
      } catch (error) {
        const code = (error as { code?: string }).code;

        // BYPASSRLS needs superuser; CREATE ROLE needs CREATEROLE.
        if (code === '42501') {
          log(`  role ${role.name.padEnd(15)} SKIPPED — the connecting user lacks privilege`);
          log(`       ask a superuser to run: CREATE ROLE ${role.name} LOGIN ${role.attrs};`);
          continue;
        }
        throw error;
      }
    }

    // ---- Database ----------------------------------------------------------
    const { rowCount: exists } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      DB_NAME,
    ]);

    if (exists && drop) {
      log(`\n  dropping database ${DB_NAME} (--drop)`);
      // Terminate stragglers, or DROP DATABASE fails on an open connection.
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [DB_NAME],
      );
      await client.query(`DROP DATABASE ${ident(DB_NAME)}`);
    }

    if (!exists || drop) {
      const owner = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', ['hims_owner']))
        .rowCount
        ? ' OWNER hims_owner'
        : '';
      await client.query(`CREATE DATABASE ${ident(DB_NAME)}${owner}`);
      log(`  database ${DB_NAME.padEnd(11)} created`);
    } else {
      log(`  database ${DB_NAME.padEnd(11)} already exists   (re-run with --drop to recreate)`);
    }

    for (const role of ROLES) {
      await client
        .query(`GRANT CONNECT ON DATABASE ${ident(DB_NAME)} TO ${ident(role.name)}`)
        .catch(() => undefined);
    }
  } finally {
    await client.end();
  }

  log('\nNext:');
  log('  pnpm db:migrate     apply the schema');
  log('  pnpm db:seed        two hospitals of demo data');
  log('  pnpm dev            API on :4000, web on :3000\n');
  log('If your .env still has the placeholder keys, the API will refuse to boot.');
  log('Generate real ones:');
  log('  openssl rand -base64 32   # MASTER_KEY, and again for BLIND_INDEX_KEY');
  log('  openssl rand -base64 48   # JWT_ACCESS_SECRET, and again for JWT_REFRESH_SECRET\n');
}

main().catch((error) => {
  process.stderr.write(`\ndatabase creation failed: ${error instanceof Error ? error.message : error}\n\n`);
  process.exit(1);
});
