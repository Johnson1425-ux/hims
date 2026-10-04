/**
 * In-app notifications.
 *
 * Scoped to the signed-in user, always. A notification carrying a patient id
 * is addressed to a person, not to a role: showing a colleague's critical-result
 * alert to anyone who happens to hold the same permission would widen the
 * circle of people who know a named patient has an abnormal result, which is
 * the opposite of what the alert is for.
 *
 * Reading is recorded separately from delivery (migration 0015). `status`
 * means the message reached its channel; `read_at` means a human opened it.
 * Conflating them would break the worker's retry logic, which keys off exactly
 * the delivery values.
 *
 * Unaddressed in-app rows — a stock alert, say — are deliberately NOT shown
 * here. They belong to a place, not a person, and that place already displays
 * them with the actions that resolve them: the alert queue on the inventory
 * screen. Fanning them into everybody's bell would make the bell the thing
 * people learn to ignore.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { param, queryParams, validate } from '../../middleware/validate.js';
import { runInTenant, runInTenantReadOnly } from '../../middleware/tenant.js';
import { booleanish } from '../../utils/schema.js';

export const notificationRoutes = Router();
notificationRoutes.use(authenticate);

const listSchema = z.object({
  unreadOnly: booleanish().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

notificationRoutes.get(
  '/',
  validate({ query: listSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = queryParams(req, listSchema);

      const result = await runInTenantReadOnly(req, async ({ db }) => {
        const { rows } = await db.query<Record<string, unknown>>(
          `SELECT id, category, priority, subject, body, payload, created_at, read_at,
                  related_kind, related_id,
                  count(*) FILTER (WHERE read_at IS NULL) OVER () AS unread_count
             FROM notifications
            WHERE channel = 'in_app'
              AND user_id = $1
              AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
            ORDER BY read_at IS NULL DESC, priority, created_at DESC
            LIMIT $3`,
          [req.principal!.userId, query.unreadOnly, query.limit],
        );

        return rows;
      });

      res.json({
        data: result,
        meta: { unread: Number(result[0]?.unread_count ?? 0) },
      });
    } catch (error) {
      next(error);
    }
  },
);

notificationRoutes.post(
  '/:notificationId/read',
  validate({ params: z.object({ notificationId: z.string().uuid() }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const notificationId = param(req, 'notificationId');

      const data = await runInTenant(req, async ({ db }) => {
        // The user_id predicate is the authorisation: marking someone else's
        // notification read is not a thing this endpoint can be asked to do.
        const { rowCount } = await db.query(
          `UPDATE notifications
              SET read_at = now()
            WHERE id = $1 AND user_id = $2 AND channel = 'in_app' AND read_at IS NULL`,
          [notificationId, req.principal!.userId],
        );

        return { updated: rowCount === 1 };
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

notificationRoutes.post('/read-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await runInTenant(req, async ({ db }) => {
      const { rowCount } = await db.query(
        `UPDATE notifications
            SET read_at = now()
          WHERE user_id = $1 AND channel = 'in_app' AND read_at IS NULL`,
        [req.principal!.userId],
      );

      return { marked: rowCount ?? 0 };
    });

    res.json({ data });
  } catch (error) {
    next(error);
  }
});
