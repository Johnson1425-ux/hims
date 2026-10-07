/**
 * Database access.
 *
 * THE CENTRAL RULE OF THIS FILE
 * -----------------------------
 * Row-level security is driven by the `hims.tenant_id` session variable, set
 * with `set_config(..., is_local => true)` so it is scoped to the current
 * TRANSACTION. That is the only scope that is safe behind a transaction-pooling
 * proxy: a session-level SET would leak to whichever tenant's request next
 * borrowed the same physical connection.
 *
 * So all tenant-scoped work goes through `withTenant()`, which opens a
 * transaction, stamps the context, and releases the connection afterwards.
 * `query()` without a tenant exists only for login and migrations, and returns
 * nothing for RLS-protected tables by design.
 */
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { env, isProduction } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { InternalError, PG_CODES, isPgError } from '../utils/errors.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
  // A runaway query must not hold a connection the clinical path needs.
  statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
  query_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
  application_name: 'hims-api',
});

pool.on('error', (err) => {
  // Fires for idle clients; the pool recovers on its own, so log and continue.
  logger.error({ err }, 'idle database client errored');
});

/** Interface shared by the pool and a transaction client, so repositories accept either. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * The context every tenant-scoped repository call receives.
 * `db` is always a transaction client with RLS context already applied.
 */
export interface TenantContext {
  tenantId: string;
  actorUserId: string | null;
  db: Queryable;
}

const SLOW_QUERY_MS = 500;

async function instrumented<R extends QueryResultRow>(
  client: Queryable,
  sql: string,
  params?: readonly unknown[],
): Promise<QueryResult<R>> {
  const startedAt = process.hrtime.bigint();
  try {
    return await client.query<R>(sql, params);
  } finally {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (elapsedMs > SLOW_QUERY_MS) {
      // Log the statement shape only. Parameters hold PHI.
      logger.warn(
        { elapsedMs: Math.round(elapsedMs), sql: sql.replace(/\s+/g, ' ').slice(0, 200) },
        'slow query',
      );
    }
  }
}

/**
 * Untenanted query. Use for authentication lookups (which run before a tenant
 * is known, through SECURITY DEFINER functions) and for platform-level reads.
 * RLS still applies, so this sees nothing on tenant-scoped tables.
 */
export async function query<R extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: readonly unknown[],
): Promise<QueryResult<R>> {
  return instrumented<R>(pool, sql, params);
}

export interface WithTenantOptions {
  /** Actor recorded in `hims.actor_id`, available to database triggers. */
  actorUserId?: string | null;
  /** SERIALIZABLE for booking and dispensing; READ COMMITTED is the default. */
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  /** Reject writes. Use for reporting so a report can never mutate a chart. */
  readOnly?: boolean;
}

/**
 * Run `fn` inside a transaction with tenant context applied.
 *
 * Commits on success, rolls back on any throw. Retries once on a
 * serialization failure or deadlock, which are expected under concurrent
 * booking and dispensing rather than exceptional.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (ctx: TenantContext) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  const { actorUserId = null, isolation = 'read committed', readOnly = false } = options;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation.toUpperCase()}`);
      if (readOnly) {
        await client.query('SET TRANSACTION READ ONLY');
      }

      // The RLS contract. Transaction-local, so it cannot outlive this block.
      await client.query('SELECT hims_util.set_request_context($1, $2, true)', [
        tenantId,
        actorUserId,
      ]);

      const wrapped: Queryable = {
        query: (sql, params) => instrumented(client as PoolClient, sql, params),
      };

      const result = await fn({ tenantId, actorUserId, db: wrapped });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch((rollbackError) => {
        logger.error({ err: rollbackError }, 'rollback failed');
      });

      const retryable =
        isPgError(error) &&
        (error.code === PG_CODES.SERIALIZATION_FAILURE || error.code === PG_CODES.DEADLOCK_DETECTED);

      if (retryable && attempt < maxAttempts) {
        logger.info({ attempt, code: error.code }, 'retrying transaction after concurrency conflict');
        continue;
      }

      throw error;
    } finally {
      client.release();
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new InternalError(new Error('transaction retry loop exhausted'));
}

/* ---------------------------------------------------------------------------
 * The privileged pool
 *
 * `hims_app` has no BYPASSRLS, which is the whole point of it — so a function
 * that claims to work across tenants cannot be served from the same pool. It
 * needs `hims_platform`, on its own connection string.
 *
 * Created lazily and only when `DATABASE_PLATFORM_URL` is set: a deployment
 * that has not deliberately turned on cross-tenant access should not be
 * holding open a connection capable of it. Kept small for the same reason —
 * this pool exists for a handful of support operations, not for traffic.
 * ------------------------------------------------------------------------- */

let privilegedPool: Pool | null = null;

function platformPool(): Pool {
  if (!env.DATABASE_PLATFORM_URL) {
    throw new InternalError(
      new Error('DATABASE_PLATFORM_URL is not configured; cross-tenant access is unavailable'),
    );
  }

  privilegedPool ??= new Pool({
    connectionString: env.DATABASE_PLATFORM_URL,
    max: Math.min(5, env.DATABASE_POOL_MAX),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    query_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    // Distinct in pg_stat_activity, so a cross-tenant query is identifiable
    // in the logs of a database that should mostly not be serving them.
    application_name: 'hims-platform',
  });

  privilegedPool.on('error', (err) => {
    logger.error({ err }, 'idle platform database client errored');
  });

  return privilegedPool;
}

/** Whether cross-tenant access is available in this deployment. */
export function hasPlatformConnection(): boolean {
  return Boolean(env.DATABASE_PLATFORM_URL);
}

/**
 * Cross-tenant work: the vendor console, nightly rollups, the notification
 * worker draining every tenant's outbox.
 *
 * Runs on the BYPASSRLS pool above. It previously ran on the ordinary `pool`
 * despite a comment promising otherwise, so it did NOT in fact escape row
 * level security — every call was silently filtered to nothing. Every call
 * site must be able to justify itself in a security review, which is why this
 * demands a written reason and logs it.
 */
export async function withoutTenantIsolation<T>(
  reason: string,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const client = await platformPool().connect();
  logger.warn({ reason }, 'running a query outside tenant isolation');

  try {
    await client.query('BEGIN');
    await client.query('SELECT hims_util.set_request_context(NULL, NULL, true)');
    const result = await fn({ query: (sql, params) => instrumented(client, sql, params) });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Liveness probe for /health. */
export async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number }> {
  const startedAt = Date.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    logger.error({ err: error }, 'database health check failed');
    return { ok: false, latencyMs: Date.now() - startedAt };
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
  if (privilegedPool) {
    await privilegedPool.end();
    privilegedPool = null;
  }
}

/* ---------------------------------------------------------------------------
 * Small query helpers. Deliberately thin: an ORM would hide the tenant
 * contract above, and hiding it is how cross-tenant leaks happen.
 * ------------------------------------------------------------------------- */

export async function one<R extends QueryResultRow>(
  db: Queryable,
  sql: string,
  params?: readonly unknown[],
): Promise<R | null> {
  const { rows } = await db.query<R>(sql, params);
  return rows[0] ?? null;
}

export async function many<R extends QueryResultRow>(
  db: Queryable,
  sql: string,
  params?: readonly unknown[],
): Promise<R[]> {
  const { rows } = await db.query<R>(sql, params);
  return rows;
}

export async function count(
  db: Queryable,
  sql: string,
  params?: readonly unknown[],
): Promise<number> {
  const { rows } = await db.query<{ count: string }>(sql, params);
  return Number(rows[0]?.count ?? 0);
}

if (!isProduction) {
  logger.debug({ max: env.DATABASE_POOL_MAX }, 'database pool initialised');
}
