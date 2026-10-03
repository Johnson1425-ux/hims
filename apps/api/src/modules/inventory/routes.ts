import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireStaffAccount } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';
import {
  acknowledgeAlertSchema,
  adjustStockSchema,
  dispenseSchema,
  receiveStockSchema,
  stockStatusSchema,
} from './schemas.js';

export const inventoryRoutes = Router();

inventoryRoutes.use(authenticate, requireStaffAccount());

inventoryRoutes.get(
  '/stock',
  requirePermission('inventory:read'),
  validate({ query: stockStatusSchema }),
  controller.stockStatus,
);

inventoryRoutes.post(
  '/stock/receive',
  requirePermission('inventory:write'),
  validate({ body: receiveStockSchema }),
  controller.receive,
);

inventoryRoutes.post(
  '/stock/adjust',
  requirePermission('inventory:write'),
  validate({ body: adjustStockSchema }),
  controller.adjust,
);

inventoryRoutes.get('/alerts', requirePermission('inventory:read'), controller.alerts);

inventoryRoutes.patch(
  '/alerts/:alertId',
  requirePermission('inventory:write'),
  validate({ params: z.object({ alertId: z.string().uuid() }), body: acknowledgeAlertSchema }),
  controller.updateAlert,
);

// Dispensing lives here rather than under /prescriptions because it is the act
// that moves stock, and the pharmacist is the actor.
inventoryRoutes.post(
  '/dispense',
  requirePermission('prescription:dispense'),
  validate({ body: dispenseSchema }),
  controller.dispense,
);
