import { z } from 'zod';
import { booleanish } from '../../utils/schema.js';

export const stockStatusSchema = z.object({
  locationId: z.string().uuid().optional(),
  category: z
    .enum(['medication', 'vaccine', 'consumable', 'reagent', 'instrument', 'ppe', 'implant', 'other'])
    .optional(),
  state: z.enum(['ok', 'low', 'critical', 'out_of_stock', 'overstocked']).optional(),
  /** Only items whose earliest batch expires within n days. */
  expiringWithinDays: z.coerce.number().int().min(1).max(730).optional(),
  controlledOnly: booleanish().optional(),
  q: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const receiveStockSchema = z.object({
  itemId: z.string().uuid(),
  locationId: z.string().uuid(),
  lotNumber: z.string().min(1).max(80),
  quantity: z.coerce.number().positive().max(1_000_000),
  unitCostCents: z.coerce.number().int().min(0),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  supplierId: z.string().uuid().optional(),
  purchaseOrderId: z.string().uuid().optional(),
});

export const adjustStockSchema = z.object({
  itemId: z.string().uuid(),
  locationId: z.string().uuid(),
  batchId: z.string().uuid().optional(),
  /** Signed: negative for wastage, positive for a found-stock correction. */
  quantity: z.coerce.number().refine((v) => v !== 0, 'An adjustment of zero changes nothing.'),
  movementType: z.enum(['adjustment', 'wastage', 'expiry', 'recall', 'stock_take', 'return']),
  reason: z.string().min(3, 'Record why stock is being adjusted.').max(500),
  /** Required for controlled substances; enforced in the service. */
  witnessedBy: z.string().uuid().optional(),
});

export const dispenseSchema = z.object({
  prescriptionId: z.string().uuid(),
  locationId: z.string().uuid(),
  items: z
    .array(
      z.object({
        prescriptionItemId: z.string().uuid(),
        /** Omitted means dispense the full outstanding quantity. */
        quantity: z.coerce.number().positive().optional(),
        /** Substituting a generic for the brand prescribed. */
        substituteItemId: z.string().uuid().optional(),
        substitutionReason: z.string().max(300).optional(),
      }),
    )
    .min(1, 'Select at least one line to dispense.'),
  counsellingGiven: z.boolean().default(false),
  checkedBy: z.string().uuid().optional(),
});

export const acknowledgeAlertSchema = z.object({
  action: z.enum(['acknowledge', 'ordered', 'resolve', 'suppress']),
  note: z.string().max(500).optional(),
});

export type StockStatusQuery = z.infer<typeof stockStatusSchema>;
export type ReceiveStockInput = z.infer<typeof receiveStockSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export type DispenseInput = z.infer<typeof dispenseSchema>;
