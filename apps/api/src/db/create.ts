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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Client } from 'pg';
import { loadEnv } from '../config/load-env.js';

const execFileAsync = promisify(execFile);

const ENV_FILES = loadEnv();

// 5433 matches the host port infra/docker-compose.yml publishes by default;
// see the comment there for why it is not 5432.
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@localhost:5433/postgres';

const DB_NAME = process.env.DATABASE_NAME ?? 'hims';
/** Fixed by infra/docker-compose.yml, so it can be named in diagnostics. */
const CONTAINER = 'hims-postgres';
/** Every variable that has to agree about which port PostgreSQL is on. */
const URL_VARS = ['DATABASE_ADMIN_URL', 'DATABASE_URL', 'DATABASE_MIGRATION_URL'] as const;
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

/** A named cause, as opposed to a list of things it might be. */
interface Diagnosis {
  headline: string;
  lines: string[];
}

function portOf(url: string): string | null {
  try {
    return new URL(url).port || '5432';
  } catch {
    return null;
  }
}

/** The same URL with a different port, credentials masked, safe to print. */
function retargeted(url: string, port: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.port = port;
    return parsed.toString().replace(/:\/\/([^:/@]*):[^@]*@/, '://$1:<password>@');
  } catch {
    return null;
  }
}

/** The .env lines needed to move every client URL to `port`. */
function urlPortFixes(port: string): string[] {
  return URL_VARS.map((name) => {
    const current = process.env[name];
    const retarget = current ? retargeted(current, port) : null;
    return `  ${name}=${retarget ?? `postgresql://...@localhost:${port}/...`}`;
  });
}

/**
 * Warn when POSTGRES_PORT and the DATABASE_* URLs disagree.
 *
 * POSTGRES_PORT decides where docker compose PUBLISHES the container; the URLs
 * decide where clients look. Nothing links the two, and a mismatch does not
 * produce a connection error — it produces an authentication error from
 * whatever else happens to hold the port the URLs name, which is the least
 * informative symptom available. Checking agreement before connecting lets it
 * be said plainly instead.
 */
function checkPortAgreement(): void {
  const declared = process.env.POSTGRES_PORT;
  if (!declared) return;

  const disagree = URL_VARS.filter((name) => {
    const url = process.env[name];
    if (!url || !isLocal(url)) return false;
    return portOf(url) !== declared;
  });

  if (disagree.length === 0) return;

  log(`\n  WARNING: POSTGRES_PORT is ${declared}, but these still point elsewhere:\n`);
  for (const name of disagree) {
    log(`    ${name.padEnd(24)} port ${portOf(process.env[name] ?? '') ?? '?'}`);
  }
  log('\n  POSTGRES_PORT publishes the bundled container; the URLs say where');
  log('  clients look, and all four have to agree. If you are using your own');
  log('  PostgreSQL rather than the container, delete POSTGRES_PORT from .env —');
  log('  it means nothing then. Otherwise:\n');
  for (const line of urlPortFixes(declared)) log(`  ${line}`);
  log('');
}

function userOf(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).username) || null;
  } catch {
    return null;
  }
}

function passwordOf(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return null;
  }
}

/**
 * Warn when a DATABASE_* URL carries a different password than the one these
 * roles are given.
 *
 * DATABASE_DEV_PASSWORD is the password db:create ASSIGNS; the passwords
 * embedded in DATABASE_URL and DATABASE_MIGRATION_URL are what the API and the
 * migration runner will PRESENT. Two copies of one secret in one file, with
 * nothing keeping them equal, so they drift whenever one line is edited — and
 * the result is a database that creates cleanly and then refuses every
 * migration with `password authentication failed for user "hims_owner"`.
 *
 * Only for roles this command manages, and only locally: pointing a URL at
 * some other server with its own credentials is legitimate.
 */
function checkPasswordAgreement(): void {
  const managed = new Set<string>(ROLES.map((r) => r.name));

  const disagree = URL_VARS.filter((name) => {
    const url = process.env[name];
    if (!url || !isLocal(url)) return false;
    const user = userOf(url);
    if (!user || !managed.has(user)) return false;
    return passwordOf(url) !== DEV_PASSWORD;
  });

  if (disagree.length === 0) return;

  log('\n  WARNING: these carry a different password than DATABASE_DEV_PASSWORD:\n');
  for (const name of disagree) {
    log(`    ${name.padEnd(24)} as ${userOf(process.env[name] ?? '') ?? '?'}`);
  }
  log('\n  DATABASE_DEV_PASSWORD is the password this command ASSIGNS to the');
  log('  roles. The one inside each URL is what the API and the migration');
  log('  runner will PRESENT. Nothing keeps the two equal, so a single edited');
  log('  line produces a database that creates cleanly and then refuses every');
  log('  migration.');
  log('');
  log('  Make them the same in .env — either value, as long as it is one value.');
  log('  The roles are set from DATABASE_DEV_PASSWORD on each run, so changing');
  log('  that and re-running `pnpm db:create` is enough.');
  log('');
}

/**
 * Prove the credentials the application will actually use.
 *
 * Creating roles and reporting success says nothing about whether the API can
 * log in: the role may have pre-existed with another password, or a URL may
 * carry one that no longer matches. This connects as each URL in turn, so the
 * command either ends having demonstrated a working setup or says precisely
 * which credential is wrong.
 *
 * URLs aimed at a different server than DATABASE_ADMIN_URL are skipped rather
 * than failed: that is a deliberate configuration, not a mistake.
 */
async function verifyClientUrls(): Promise<boolean> {
  const adminHost = (() => {
    try {
      const url = new URL(ADMIN_URL);
      return `${url.hostname}:${url.port || '5432'}`;
    } catch {
      return null;
    }
  })();

  let allGood = true;
  const checked: string[] = [];

  for (const name of URL_VARS) {
    if (name === 'DATABASE_ADMIN_URL') continue;

    const url = process.env[name];
    if (!url) continue;

    let target: string | null = null;
    try {
      const parsed = new URL(url);
      target = `${parsed.hostname}:${parsed.port || '5432'}`;
    } catch {
      log(`  ${name} is not a valid URL — skipped`);
      continue;
    }

    if (target !== adminHost) {
      log(`  ${name.padEnd(24)} points at ${target} — skipped`);
      continue;
    }

    const client = new Client({ connectionString: url, application_name: 'hims-db-create-verify' });

    try {
      await client.connect();
      const { rows } = await client.query<{ who: string; db: string }>(
        'SELECT current_user AS who, current_database() AS db',
      );
      await client.end();
      checked.push(name);
      log(`  ${name.padEnd(24)} connects as ${rows[0]!.who} to ${rows[0]!.db}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      allGood = false;
      const code = (error as { code?: string }).code;
      const detail = error instanceof Error ? error.message : String(error);
      log(`  ${name.padEnd(24)} FAILED — ${detail}`);

      if (code === '28P01') {
        log('');
        log(`       The role exists, but the password in ${name} is not the`);
        log('       one it was given. DATABASE_DEV_PASSWORD is what this command');
        log('       assigns; make the URL match it, then re-run `pnpm db:create`.');
      } else if (code === '3D000') {
        log('');
        log('       That database does not exist. DATABASE_NAME decides which one');
        log(`       this command creates; it made "${DB_NAME}".`);
      }
    }
  }

  if (allGood && checked.length === 0) {
    log('  no client URLs to check (DATABASE_URL / DATABASE_MIGRATION_URL unset)');
  }

  return allGood;
}

async function docker(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('docker', args, { timeout: 15_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Ask the container itself what is wrong.
 *
 * `password authentication failed` comes from the server that ANSWERED, and on
 * Windows and macOS that is often not the container: the PostgreSQL installer
 * registers a service that starts at boot, and a published container port can
 * appear to bind while still losing `localhost` to the service already
 * listening there. The error then names credentials, when the real fault is
 * which server replied.
 *
 * Three facts from the container separate the cases: whether it is running,
 * which host port Docker published it on, and whether these same credentials
 * work inside it. Credentials that work inside but fail over the published
 * port prove the listener on that port is something else. Credentials that
 * fail inside too are a genuine credential problem, so this returns null and
 * leaves the stale-volume probe to it.
 *
 * Read-only, bounded by a timeout, and silent when Docker or the container is
 * absent.
 */
async function diagnoseFromContainer(
  host: string,
  port: string,
  user: string,
  password: string,
): Promise<Diagnosis | null> {
  const running = await docker(['inspect', '-f', '{{.State.Running}}', CONTAINER]);

  // No Docker, no daemon, or no such container: nothing to say.
  if (running === null) return null;

  if (running !== 'true') {
    return {
      headline: `the container ${CONTAINER} exists but is not running.`,
      lines: [
        'Whatever answered on that port, it was not this project’s database.',
        'Start the container, then re-run:',
        '',
        '  docker compose -f infra/docker-compose.yml up -d',
        '  pnpm db:create',
      ],
    };
  }

  const published = await docker([
    'inspect',
    '-f',
    '{{range $p := index .NetworkSettings.Ports "5432/tcp"}}{{$p.HostPort}}{{end}}',
    CONTAINER,
  ]);

  // `docker exec` reaches the server directly, past the published port and
  // anything competing for it. -h forces TCP: the image trusts unix-socket
  // connections, which would accept any password and prove nothing.
  const inside = await docker([
    'exec',
    '-e',
    `PGPASSWORD=${password}`,
    CONTAINER,
    'psql',
    '-h',
    '127.0.0.1',
    '-U',
    user,
    '-d',
    'postgres',
    '-tAc',
    'select 1',
  ]);

  // The container rejects them too, so the port is not what is wrong.
  if (inside !== '1') return null;

  if (published && published !== port) {
    return {
      headline: `the container is published on port ${published}, not ${port}.`,
      lines: [
        `The credentials are correct. Docker has the container on ${published},`,
        `while the DATABASE_* URLs say ${port}, so the connection went somewhere`,
        'else. In .env:',
        '',
        ...urlPortFixes(published),
      ],
    };
  }

  return {
    headline: `another PostgreSQL is answering on ${host}:${port}.`,
    lines: [
      `The credentials are correct — they work inside ${CONTAINER}, which`,
      `Docker has published on ${port}. Something else holds that port for`,
      '`localhost`, so the connection never reaches the container. On Windows',
      'and macOS this is the service the PostgreSQL installer registers to',
      'start at boot.',
      '',
      'Move the container to a free port. All four values have to agree, so',
      'in .env:',
      '',
      '  POSTGRES_PORT=5433',
      ...urlPortFixes('5433'),
      '',
      'then recreate the container so the new mapping applies:',
      '',
      '  docker compose -f infra/docker-compose.yml up -d --force-recreate',
      '  pnpm db:create',
      '',
      'The data volume is untouched, so nothing is lost. Stopping the native',
      'service works too, but moving aside is the smaller change — and it',
      'leaves whatever else uses that server alone.',
    ],
  };
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
async function probeForStaleVolume(host: string, port: string): Promise<Diagnosis | null> {
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
      return {
        headline: `the server accepted "${candidate}" instead of the configured user.`,
        lines: [
          `"${candidate}" was the superuser in an EARLIER version of`,
          'infra/docker-compose.yml. POSTGRES_USER is read only when the data',
          'volume is first initialised, so pulling the updated file recreated',
          'the container but left the original cluster — and its original',
          'superuser — untouched inside the volume.',
          '',
          'Removing the volume is the fix. `down` alone is not enough:',
          '',
          '  docker compose -f infra/docker-compose.yml down -v',
          '  docker compose -f infra/docker-compose.yml up -d',
          '  pnpm db:create',
          '',
          'This discards the database, which at this stage holds nothing but',
          `seed data. Do NOT instead point DATABASE_ADMIN_URL at "${candidate}":`,
          'it is a superuser there, and a superuser bypasses row-level security',
          'entirely — tenant isolation would be inert.',
        ],
      };
    } catch {
      await probe.end().catch(() => undefined);
    }
  }

  return null;
}

function reportDiagnosis(diagnosis: Diagnosis): void {
  log('');
  log(`  DIAGNOSED: ${diagnosis.headline}`);
  log('');
  for (const line of diagnosis.lines) log(line === '' ? '' : `  ${line}`);
  log('');
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
  let password = '';
  try {
    const url = new URL(ADMIN_URL);
    host = url.hostname || host;
    port = url.port || port;
    user = decodeURIComponent(url.username) || user;
    password = decodeURIComponent(url.password);
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

    // Rather than listing possibilities, find out which one it is. Both checks
    // are local-host only, read-only, and report rather than proceeding.
    if (isLocal(ADMIN_URL)) {
      const diagnosis =
        (await diagnoseFromContainer(host, port, user, password)) ??
        (await probeForStaleVolume(host, port));

      if (diagnosis) {
        reportDiagnosis(diagnosis);
        return;
      }
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
    log('     service that starts at boot and takes the port before Docker.');
    log('     The compose file publishes 5433 by default to stay clear of it,');
    log('     so this is worth checking if you moved it back to 5432.\n');
    log('       Windows:  netstat -ano | findstr :' + port);
    log('       macOS:    lsof -nP -iTCP:' + port + ' -sTCP:LISTEN');
    log('       Linux:    ss -lptn "sport = :' + port + '"\n');
    log('     Either point DATABASE_ADMIN_URL at that server with its own');
    log('     password, or leave POSTGRES_PORT at its default and set these to');
    log('     match:\n');
    for (const line of urlPortFixes('5433')) log(`    ${line}`);
    log('');
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

  // Said before connecting, because a port mismatch surfaces as an
  // authentication error from an unrelated server rather than as a failure to
  // connect, and that is almost impossible to read backwards.
  checkPortAgreement();
  checkPasswordAgreement();

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

      // An existing role is brought into line rather than left alone. Skipping
      // it is what turns a half-made setup into a stuck one: the role survives
      // in the data volume with whatever password it was first given, this
      // command reports success, and every later connection is refused. Local
      // only — resetting a password on a shared server would not be ours to do.
      const verb = rowCount ? 'ALTER' : 'CREATE';

      if (rowCount && !isLocal(ADMIN_URL)) {
        log(`  role ${role.name.padEnd(15)} already exists (password left alone: not a local host)`);
        continue;
      }

      try {
        await client.query(
          `${verb} ROLE ${ident(role.name)} WITH LOGIN PASSWORD ${literal(DEV_PASSWORD)} ${role.attrs}`,
        );
        log(
          rowCount
            ? `  role ${role.name.padEnd(15)} reset         (password set from DATABASE_DEV_PASSWORD)`
            : `  role ${role.name.padEnd(15)} created       (${role.note})`,
        );
      } catch (error) {
        const code = (error as { code?: string }).code;

        // BYPASSRLS needs superuser; CREATE ROLE needs CREATEROLE.
        if (code === '42501') {
          log(`  role ${role.name.padEnd(15)} SKIPPED — the connecting user lacks privilege`);
          log(`       ask a superuser to run: ${verb} ROLE ${role.name} LOGIN ${role.attrs};`);
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

  // Creating roles says nothing about whether the application can log in.
  // Demonstrate it, so the command cannot report success over a setup that
  // refuses the very next step.
  log('\n  verifying the credentials the application will use:\n');
  const credentialsWork = await verifyClientUrls();

  if (!credentialsWork) {
    log('\nThe database exists, but at least one configured credential does not work,');
    log('so `pnpm db:migrate` would fail. Fix the URL above and re-run this command —');
    log('it is idempotent, and it resets the roles from DATABASE_DEV_PASSWORD each run.\n');
    process.exit(1);
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
