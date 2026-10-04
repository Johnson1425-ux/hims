import type { NextFunction, Request, Response } from 'express';
import { body, param, queryParams } from '../../middleware/validate.js';
import { runInTenant } from '../../middleware/tenant.js';
import { NotFoundError } from '../../utils/errors.js';
import * as service from './service.js';
import {
  acknowledgeAlertSchema,
  adjustStockSchema,
  dispenseSchema,
  receiveStockSchema,
  stockStatusSchema,
} from './schemas.js';

export async function stockStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = queryParams(req, stockStatusSchema);
    const result = await service.getStockStatus(req, query);
    res.json({
      data: result.items,
      meta: {
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
        summary: result.summary,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function receive(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.receiveStock(req, body(req, receiveStockSchema));
    res.status(201).json({ data: result });
  } catch (error) {
    next(error);
  }
}

export async function adjust(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.adjustStock(req, body(req, adjustStockSchema));
    res.status(201).json({ data: result });
  } catch (error) {
    next(error);
  }
}

export async function dispense(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.dispense(req, body(req, dispenseSchema));
    res.status(201).json({ data: result });
  } catch (error) {
    next(error);
  }
}

export async function items(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({
      data: await service.searchItems(req, {
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        medicationsOnly: req.query.medicationsOnly === 'true',
        limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
      }),
    });
  } catch (error) {
    next(error);
  }
}

export async function locations(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ data: await service.listLocations(req) });
  } catch (error) {
    next(error);
  }
}

export async function alerts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await service.listAlerts(req, {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      severity: typeof req.query.severity === 'string' ? req.query.severity : undefined,
    });
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
}

export async function updateAlert(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = body(req, acknowledgeAlertSchema);
    const alertId = param(req, 'alertId');

    const result = await runInTenant(req, async ({ db }, collect) => {
      const nextStatus = {
        acknowledge: 'acknowledged',
        ordered: 'ordered',
        resolve: 'resolved',
        suppress: 'suppressed',
      }[input.action];

      const { rows } = await db.query<{ id: string; status: string }>(
        `UPDATE stock_alerts
            SET status = $2,
                acknowledged_by = CASE WHEN $2 = 'acknowledged' THEN $3 ELSE acknowledged_by END,
                acknowledged_at = CASE WHEN $2 = 'acknowledged' THEN now() ELSE acknowledged_at END,
                resolved_at = CASE WHEN $2 IN ('resolved','suppressed') THEN now() ELSE resolved_at END
          WHERE id = $1
          RETURNING id, status`,
        [alertId, nextStatus, req.principal!.userId],
      );

      if (rows.length === 0) throw new NotFoundError('stock alert');

      collect({
        action: `inventory.alert_${input.action}`,
        resourceType: 'stock_alert',
        resourceId: alertId,
        metadata: { note: input.note ?? null },
      });

      return rows[0]!;
    });

    res.json({ data: result });
  } catch (error) {
    next(error);
  }
}
