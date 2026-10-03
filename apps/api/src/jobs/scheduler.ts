/**
 * Scheduled maintenance.
 *
 * Deliberately a plain interval loop rather than a cron library: these tasks
 * are idempotent, so a missed or duplicated run is harmless, and one fewer
 * dependency in the deployment is worth more than precise scheduling.
 *
 * In a multi-replica deployment, each task takes a PostgreSQL advisory lock so
 * only one instance runs it.
 */
import { withoutTenantIsolation, withTenant, type Queryable } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { scanForAlerts } from '../modules/inventory/service.js';

interface Task {
  name: string;
  intervalMinutes: number;
  run: (db: Queryable) => Promise<string>;
  lastRunAt?: number;
}

/** Only one replica may run a given task at a time. */
async function withTaskLock<T>(
  db: Queryable,
  taskName: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const { rows } = await db.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
    [`hims.task.${taskName}`],
  );

  if (!rows[0]?.acquired) {
    logger.debug({ taskName }, 'task is already running on another instance');
    return null;
  }

  try {
    return await fn();
  } finally {
    await db.query('SELECT pg_advisory_unlock(hashtext($1))', [`hims.task.${taskName}`]);
  }
}

const tasks: Task[] = [
  {
    name: 'expire_sessions',
    intervalMinutes: 15,
    async run(db) {
      const { rowCount } = await db.query(
        `UPDATE auth_sessions
            SET revoked_at = now(), revoked_reason = 'expired'
          WHERE revoked_at IS NULL AND expires_at <= now()`,
      );
      return `revoked ${rowCount ?? 0} expired session(s)`;
    },
  },

  {
    name: 'purge_consumed_tokens',
    intervalMinutes: 60,
    async run(db) {
      // Reset and invitation tokens are single-use and short-lived; retaining
      // them past expiry only widens the blast radius of a database leak.
      const { rowCount } = await db.query(
        `DELETE FROM auth_tokens
          WHERE (consumed_at IS NOT NULL AND consumed_at < now() - interval '7 days')
             OR expires_at < now() - interval '7 days'`,
      );
      return `purged ${rowCount ?? 0} spent token(s)`;
    },
  },

  {
    name: 'mark_overdue_invoices',
    intervalMinutes: 60 * 6,
    async run(db) {
      const { rowCount } = await db.query(
        `UPDATE invoices
            SET status = 'overdue'
          WHERE status IN ('issued','partially_paid')
            AND due_on < CURRENT_DATE
            AND balance_cents > 0`,
      );
      return `marked ${rowCount ?? 0} invoice(s) overdue`;
    },
  },

  {
    name: 'mark_no_shows',
    intervalMinutes: 30,
    async run(db) {
      // An appointment nobody checked in for, well past its slot, is a no-show.
      // The grace period matters: marking it at the slot time would catch every
      // patient running ten minutes late.
      const { rowCount } = await db.query(
        `UPDATE appointments
            SET status = 'no_show'
          WHERE status IN ('scheduled','confirmed')
            AND ends_at < now() - interval '2 hours'
            AND checked_in_at IS NULL`,
      );
      return `marked ${rowCount ?? 0} appointment(s) as no-show`;
    },
  },

  {
    name: 'expire_waitlist_offers',
    intervalMinutes: 15,
    async run(db) {
      const { rowCount } = await db.query(
        `UPDATE appointment_waitlist
            SET status = 'waiting', offered_at = NULL, offer_expires_at = NULL
          WHERE status = 'offered' AND offer_expires_at < now()`,
      );
      return `returned ${rowCount ?? 0} lapsed offer(s) to the waitlist`;
    },
  },

  {
    name: 'refresh_consumption_rates',
    intervalMinutes: 60 * 24,
    async run(db) {
      // Average daily usage over the trailing 90 days drives days-of-cover and
      // the reorder suggestion. Computed nightly rather than per request.
      const { rowCount } = await db.query(
        `
        UPDATE inventory_items i
           SET avg_daily_usage = COALESCE(usage.rate, 0)
          FROM (
            SELECT item_id,
                   round(sum(abs(quantity)) / 90.0, 3) AS rate
              FROM stock_movements
             WHERE movement_type IN ('dispense','administer')
               AND occurred_at >= now() - interval '90 days'
             GROUP BY item_id
          ) AS usage
         WHERE i.id = usage.item_id
        `,
      );
      return `refreshed consumption rates for ${rowCount ?? 0} item(s)`;
    },
  },

  {
    name: 'stock_alert_sweep',
    intervalMinutes: 60 * 4,
    async run(db) {
      // Per-tenant, because alerting writes tenant-scoped rows that RLS would
      // otherwise reject.
      const { rows: tenants } = await db.query<{ id: string }>(
        `SELECT id FROM tenants WHERE status = 'active'`,
      );

      let total = 0;
      for (const tenant of tenants) {
        total += await withTenant(tenant.id, async ({ db: tenantDb }) =>
          scanForAlerts(tenantDb, tenant.id),
        );
      }

      return `raised or refreshed ${total} stock alert(s) across ${tenants.length} tenant(s)`;
    },
  },

  {
    name: 'verify_audit_chain',
    intervalMinutes: 60 * 24,
    async run(db) {
      // A broken chain means the audit trail has been tampered with. This is a
      // security incident, not a maintenance warning.
      const { rows } = await db.query<{ broken_at_id: string }>(
        'SELECT broken_at_id FROM hims_util.verify_audit_chain()',
      );

      if (rows.length > 0) {
        logger.fatal(
          { brokenAtId: rows[0]!.broken_at_id },
          'AUDIT CHAIN VERIFICATION FAILED - the audit trail has been altered. Escalate immediately.',
        );
        return `AUDIT CHAIN BROKEN at row ${rows[0]!.broken_at_id}`;
      }

      return 'audit chain verified intact';
    },
  },

  {
    name: 'flag_unreviewed_break_glass',
    intervalMinutes: 60 * 12,
    async run(db) {
      // Emergency access is only defensible because it gets reviewed. Grants
      // older than 72 hours with no review are escalated.
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*) FROM break_glass_grants
          WHERE reviewed_at IS NULL AND created_at < now() - interval '72 hours'`,
      );

      const overdue = Number(rows[0]?.count ?? 0);
      if (overdue > 0) {
        logger.warn({ overdue }, 'break-glass grants awaiting privacy review for over 72 hours');
      }

      return `${overdue} break-glass grant(s) overdue for review`;
    },
  },
];

let running = true;

async function tick(): Promise<void> {
  const now = Date.now();

  for (const task of tasks) {
    const dueAt = (task.lastRunAt ?? 0) + task.intervalMinutes * 60_000;
    if (now < dueAt) continue;

    task.lastRunAt = now;

    try {
      const outcome = await withoutTenantIsolation(
        `scheduled task: ${task.name}`,
        async (db) => withTaskLock(db, task.name, () => task.run(db)),
      );

      if (outcome !== null) {
        logger.info({ task: task.name }, outcome);
      }
    } catch (error) {
      logger.error({ err: error, task: task.name }, 'scheduled task failed');
    }
  }
}

async function loop(): Promise<void> {
  logger.info({ taskCount: tasks.length }, 'scheduler started');

  while (running) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}

process.on('SIGTERM', () => {
  logger.info('scheduler stopping');
  running = false;
});

void loop();
