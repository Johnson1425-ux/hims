/**
 * Inventory and pharmacy.
 *
 * Every quantity change is an INSERT into `stock_movements`; nothing in this
 * file writes a balance. The database trigger derives the balance, refuses to
 * let it go negative, and blocks edits to the ledger. That is what makes the
 * controlled-drug register defensible and what stops "phantom stock" — a
 * failed dispense that already decremented a counter.
 */
import type { Request } from 'express';
import { AppError, InsufficientStockError, NotFoundError } from '../../utils/errors.js';
import { runInTenant, runInTenantReadOnly, runInTenantSerializable } from '../../middleware/tenant.js';
import { logger } from '../../utils/logger.js';
import type { Queryable } from '../../db/pool.js';
import type { AdjustStockInput, DispenseInput, ReceiveStockInput, StockStatusQuery } from './schemas.js';

/* ---------------------------------------------------------------------------
 * Stock status
 * ------------------------------------------------------------------------- */

export interface StockStatusItem {
  itemId: string;
  locationId: string;
  sku: string;
  name: string;
  category: string;
  locationName: string;
  baseUnit: string;
  controlledSchedule: string | null;
  quantityOnHand: number;
  quantityAvailable: number;
  reorderLevel: number;
  criticalLevel: number;
  reorderQuantity: number;
  daysOfCover: number | null;
  stockState: string;
  earliestExpiry: string | null;
}

/**
 * Read the stock board.
 *
 * Sourced from `v_stock_status`, which is the single definition of what "low"
 * means. Both this endpoint and the alerting job read that view, so the badge
 * on screen and the alert in someone's inbox can never disagree.
 */
export async function getStockStatus(
  req: Request,
  input: StockStatusQuery,
): Promise<{ items: StockStatusItem[]; total: number; summary: Record<string, number> }> {
  return runInTenantReadOnly(req, async ({ db }) => {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const where = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace('$?', `$${params.length}`));
    };

    if (input.locationId) where('location_id = $?', input.locationId);
    if (input.category) where('category = $?', input.category);
    if (input.state) where('stock_state = $?', input.state);
    if (input.controlledOnly) conditions.push('controlled_schedule IS NOT NULL');
    if (input.expiringWithinDays) {
      where("earliest_expiry IS NOT NULL AND earliest_expiry <= CURRENT_DATE + make_interval(days => $?)", input.expiringWithinDays);
    }
    if (input.q) {
      params.push(input.q);
      conditions.push(`(name ILIKE '%' || $${params.length} || '%' OR sku ILIKE '%' || $${params.length} || '%')`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (input.page - 1) * input.pageSize;

    // count(*) OVER () is evaluated before LIMIT, so the page and its total
    // come back from ONE scan of the view. A separate `SELECT count(*)` with
    // the same WHERE clause scanned it a second time for a number the first
    // query already had in hand — and this view aggregates batches, so a scan
    // is not cheap.
    const [{ rows }, { rows: summaryRows }] = await Promise.all([
      db.query<Record<string, unknown>>(
        `SELECT *, count(*) OVER () AS total_count
           FROM v_stock_status ${whereClause}
          ORDER BY CASE stock_state
                     WHEN 'out_of_stock' THEN 0 WHEN 'critical' THEN 1
                     WHEN 'low' THEN 2 WHEN 'overstocked' THEN 3 ELSE 4 END,
                   name
          LIMIT ${input.pageSize} OFFSET ${offset}`,
        params,
      ),
      // Headline counts for the dashboard tiles, unaffected by paging.
      db.query<{ stock_state: string; count: string }>(
        'SELECT stock_state, count(*) FROM v_stock_status GROUP BY stock_state',
      ),
    ]);

    return {
      items: rows.map((row) => ({
        itemId: row.item_id as string,
        locationId: row.location_id as string,
        sku: row.sku as string,
        name: row.name as string,
        category: row.category as string,
        locationName: row.location_name as string,
        baseUnit: row.base_unit as string,
        controlledSchedule: (row.controlled_schedule as string | null) ?? null,
        quantityOnHand: Number(row.quantity_on_hand),
        quantityAvailable: Number(row.quantity_available),
        reorderLevel: Number(row.reorder_level),
        criticalLevel: Number(row.critical_level),
        reorderQuantity: Number(row.reorder_quantity),
        daysOfCover: row.days_of_cover === null ? null : Number(row.days_of_cover),
        stockState: row.stock_state as string,
        earliestExpiry: row.earliest_expiry
          ? (row.earliest_expiry as Date).toISOString().slice(0, 10)
          : null,
      })),
      // No rows means nothing matched, so the window function produced no
      // value to read — which is the same as a total of zero.
      total: Number(rows[0]?.total_count ?? 0),
      summary: Object.fromEntries(summaryRows.map((r) => [r.stock_state, Number(r.count)])),
    };
  });
}

/* ---------------------------------------------------------------------------
 * Goods receipt and adjustments
 * ------------------------------------------------------------------------- */

export async function receiveStock(
  req: Request,
  input: ReceiveStockInput,
): Promise<{ batchId: string; movementId: string; newBalance: number }> {
  return runInTenant(req, async ({ db, tenantId }, collect) => {
    const principal = req.principal!;

    const { rows: itemRows } = await db.query<{
      name: string;
      controlled_schedule: string | null;
      requires_cold_chain: boolean;
    }>('SELECT name, controlled_schedule, requires_cold_chain FROM inventory_items WHERE id = $1', [
      input.itemId,
    ]);

    const item = itemRows[0];
    if (!item) throw new NotFoundError('inventory item');

    // Custody rules for controlled drugs and the cold chain are physical
    // constraints; the location has to be fit for the goods.
    const { rows: locRows } = await db.query<{
      allows_controlled: boolean;
      temperature_controlled: boolean;
      name: string;
    }>('SELECT allows_controlled, temperature_controlled, name FROM inventory_locations WHERE id = $1', [
      input.locationId,
    ]);

    const location = locRows[0];
    if (!location) throw new NotFoundError('inventory location');

    if (item.controlled_schedule && !location.allows_controlled) {
      throw new AppError(
        422,
        'VALIDATION_FAILED',
        `${item.name} is a schedule ${item.controlled_schedule} drug and must be stored in a controlled cabinet.`,
      );
    }
    if (item.requires_cold_chain && !location.temperature_controlled) {
      throw new AppError(
        422,
        'VALIDATION_FAILED',
        `${item.name} requires cold-chain storage; ${location.name} is not temperature controlled.`,
      );
    }
    if (input.expiresOn && input.expiresOn <= new Date().toISOString().slice(0, 10)) {
      throw new AppError(422, 'VALIDATION_FAILED', 'That batch has already expired.');
    }

    // A re-delivery of the same lot tops up the existing batch rather than
    // creating a second row with the same lot number.
    const { rows: batchRows } = await db.query<{ id: string }>(
      `INSERT INTO stock_batches (tenant_id, item_id, location_id, lot_number, expires_on,
                                  supplier_id, unit_cost_cents, quantity_received)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (item_id, location_id, lot_number) DO UPDATE
         SET quantity_received = stock_batches.quantity_received + EXCLUDED.quantity_received,
             status = CASE WHEN stock_batches.status = 'depleted' THEN 'available' ELSE stock_batches.status END,
             updated_at = now()
       RETURNING id`,
      [
        tenantId,
        input.itemId,
        input.locationId,
        input.lotNumber,
        input.expiresOn ?? null,
        input.supplierId ?? null,
        input.unitCostCents,
        input.quantity,
      ],
    );

    const batchId = batchRows[0]!.id;

    const { rows: moveRows } = await db.query<{ id: string; balance_after: string }>(
      `INSERT INTO stock_movements (tenant_id, item_id, location_id, batch_id, quantity,
                                    movement_type, reason, reference_kind, reference_id,
                                    unit_cost_cents, balance_after, performed_by)
       VALUES ($1, $2, $3, $4, $5, 'receipt', $6, $7, $8, $9, 0, $10)
       RETURNING id, balance_after`,
      [
        tenantId,
        input.itemId,
        input.locationId,
        batchId,
        input.quantity,
        `Goods receipt, lot ${input.lotNumber}`,
        input.purchaseOrderId ? 'purchase_order' : 'manual',
        input.purchaseOrderId ?? null,
        input.unitCostCents,
        principal.userId,
      ],
    );

    if (input.purchaseOrderId) {
      await db.query(
        `UPDATE purchase_order_lines
            SET quantity_received = quantity_received + $3
          WHERE purchase_order_id = $1 AND item_id = $2`,
        [input.purchaseOrderId, input.itemId, input.quantity],
      );
    }

    // A receipt may well clear an open shortage.
    await resolveAlertsIfRecovered(db, input.itemId, input.locationId);

    collect({
      action: 'inventory.receive',
      resourceType: 'inventory_item',
      resourceId: input.itemId,
      metadata: {
        lotNumber: input.lotNumber,
        quantity: input.quantity,
        locationId: input.locationId,
        controlled: Boolean(item.controlled_schedule),
      },
    });

    return {
      batchId,
      movementId: moveRows[0]!.id,
      newBalance: Number(moveRows[0]!.balance_after),
    };
  });
}

export async function adjustStock(
  req: Request,
  input: AdjustStockInput,
): Promise<{ movementId: string; newBalance: number }> {
  return runInTenant(req, async ({ db, tenantId }, collect) => {
    const principal = req.principal!;

    const { rows: itemRows } = await db.query<{ name: string; controlled_schedule: string | null }>(
      'SELECT name, controlled_schedule FROM inventory_items WHERE id = $1',
      [input.itemId],
    );

    const item = itemRows[0];
    if (!item) throw new NotFoundError('inventory item');

    // Writing off a controlled drug without a second signature is how diversion
    // goes unnoticed. The witness is mandatory and recorded on the ledger row.
    if (item.controlled_schedule && !input.witnessedBy) {
      throw new AppError(
        422,
        'VALIDATION_FAILED',
        `${item.name} is a controlled drug. A second member of staff must witness and countersign this adjustment.`,
      );
    }
    if (input.witnessedBy && input.witnessedBy === principal.userId) {
      throw new AppError(422, 'VALIDATION_FAILED', 'The witness must be a different member of staff.');
    }

    let movementId: string;
    let newBalance: number;

    try {
      const { rows } = await db.query<{ id: string; balance_after: string }>(
        `INSERT INTO stock_movements (tenant_id, item_id, location_id, batch_id, quantity,
                                      movement_type, reason, reference_kind, balance_after,
                                      performed_by, witnessed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', 0, $8, $9)
         RETURNING id, balance_after`,
        [
          tenantId,
          input.itemId,
          input.locationId,
          input.batchId ?? null,
          input.quantity,
          input.movementType,
          input.reason,
          principal.userId,
          input.witnessedBy ?? null,
        ],
      );

      movementId = rows[0]!.id;
      newBalance = Number(rows[0]!.balance_after);
    } catch (error) {
      // The trigger refuses to let a balance go negative.
      if ((error as { message?: string }).message?.includes('negative')) {
        throw new AppError(
          409,
          'INSUFFICIENT_STOCK',
          'That adjustment would take the balance below zero. Check the quantity and the location.',
        );
      }
      throw error;
    }

    await raiseAlertsIfBreached(db, tenantId, input.itemId, input.locationId);

    collect({
      action: `inventory.${input.movementType}`,
      resourceType: 'inventory_item',
      resourceId: input.itemId,
      metadata: {
        quantity: input.quantity,
        reason: input.reason,
        controlled: Boolean(item.controlled_schedule),
        witnessedBy: input.witnessedBy ?? null,
        newBalance,
      },
    });

    if (item.controlled_schedule) {
      logger.warn(
        { itemId: input.itemId, quantity: input.quantity, type: input.movementType },
        'controlled-drug stock adjustment recorded',
      );
    }

    return { movementId, newBalance };
  });
}

/* ---------------------------------------------------------------------------
 * Dispensing
 * ------------------------------------------------------------------------- */

export interface DispenseResult {
  dispenseId: string;
  reference: string;
  lines: Array<{ medicationName: string; quantity: number; lotNumber: string | null; batchId: string | null }>;
  prescriptionStatus: string;
}

/**
 * Dispense against a prescription.
 *
 * Serializable, because two pharmacists working the same queue must not both
 * commit the last pack. Batches are picked FIRST-EXPIRY-FIRST-OUT, which is
 * the correct rule for medicines (plain FIFO leaves short-dated stock on the
 * shelf to expire).
 */
export async function dispense(req: Request, input: DispenseInput): Promise<DispenseResult> {
  return runInTenantSerializable(req, async ({ db, tenantId }, collect) => {
    const principal = req.principal!;

    if (!principal.staffProfileId) {
      throw new AppError(403, 'FORBIDDEN', 'Only registered pharmacy staff can dispense medication.');
    }

    const { rows: rxRows } = await db.query<{
      id: string;
      patient_id: string;
      status: string;
      valid_until: Date | null;
      fulfilment: string;
    }>(
      `SELECT id, patient_id, status, valid_until, fulfilment
         FROM prescriptions WHERE id = $1`,
      [input.prescriptionId],
    );

    const prescription = rxRows[0];
    if (!prescription) throw new NotFoundError('prescription');

    if (!['active', 'partially_dispensed'].includes(prescription.status)) {
      throw new AppError(
        409,
        'PRECONDITION_FAILED',
        `This prescription is ${prescription.status.replace('_', ' ')} and cannot be dispensed.`,
      );
    }
    if (prescription.valid_until && prescription.valid_until < new Date()) {
      throw new AppError(409, 'PRECONDITION_FAILED', 'This prescription has expired. Ask the prescriber to reissue it.');
    }
    if (prescription.fulfilment !== 'in_house') {
      throw new AppError(
        422,
        'VALIDATION_FAILED',
        'This prescription is marked for external fulfilment and must not be dispensed here.',
      );
    }

    const { rows: refRows } = await db.query<{ id: string; reference: string }>(
      `SELECT gen_random_uuid() AS id,
              hims_util.allocate_reference($1, 'dispense', 'DSP') AS reference`,
      [tenantId],
    );
    const { id: dispenseId, reference } = refRows[0]!;

    // Controlled drugs need the checking pharmacist recorded before any stock
    // moves, so the header is written first.
    await db.query(
      `INSERT INTO dispenses (id, tenant_id, reference, prescription_id, patient_id, location_id,
                              dispensed_by, checked_by, counselling_given)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        dispenseId,
        tenantId,
        reference,
        input.prescriptionId,
        prescription.patient_id,
        input.locationId,
        principal.staffProfileId,
        input.checkedBy ?? null,
        input.counsellingGiven,
      ],
    );

    const lines: DispenseResult['lines'] = [];

    for (const line of input.items) {
      const { rows: itemRows } = await db.query<{
        id: string;
        item_id: string | null;
        medication_name: string;
        quantity_prescribed: string;
        quantity_dispensed: string;
        status: string;
      }>(
        `SELECT id, item_id, medication_name, quantity_prescribed, quantity_dispensed, status
           FROM prescription_items
          WHERE id = $1 AND prescription_id = $2`,
        [line.prescriptionItemId, input.prescriptionId],
      );

      const rxItem = itemRows[0];
      if (!rxItem) throw new NotFoundError('prescription line');

      const outstanding = Number(rxItem.quantity_prescribed) - Number(rxItem.quantity_dispensed);
      if (outstanding <= 0) {
        throw new AppError(
          409,
          'PRECONDITION_FAILED',
          `${rxItem.medication_name} has already been dispensed in full.`,
        );
      }

      const quantity = line.quantity ?? outstanding;
      if (quantity > outstanding) {
        throw new AppError(
          422,
          'VALIDATION_FAILED',
          `Only ${outstanding} of ${rxItem.medication_name} remain on this prescription.`,
        );
      }

      const stockItemId = line.substituteItemId ?? rxItem.item_id;
      if (!stockItemId) {
        throw new AppError(
          422,
          'VALIDATION_FAILED',
          `${rxItem.medication_name} is not linked to a stocked product. Record a substitution.`,
        );
      }

      // FEFO: consume the earliest-expiring available batch first, spanning
      // several batches when one cannot cover the quantity.
      const { rows: batches } = await db.query<{
        id: string;
        lot_number: string;
        quantity_on_hand: string;
        unit_cost_cents: number;
      }>(
        `SELECT id, lot_number, quantity_on_hand, unit_cost_cents
           FROM stock_batches
          WHERE item_id = $1 AND location_id = $2
            AND status = 'available' AND quantity_on_hand > 0
            AND (expires_on IS NULL OR expires_on > CURRENT_DATE)
          ORDER BY expires_on NULLS LAST, received_on
          FOR UPDATE`,
        [stockItemId, input.locationId],
      );

      const totalAvailable = batches.reduce((sum, b) => sum + Number(b.quantity_on_hand), 0);
      if (totalAvailable < quantity) {
        throw new InsufficientStockError(rxItem.medication_name, totalAvailable, quantity);
      }

      let remaining = quantity;

      for (const batch of batches) {
        if (remaining <= 0) break;

        const take = Math.min(remaining, Number(batch.quantity_on_hand));

        const { rows: moveRows } = await db.query<{ id: string }>(
          `INSERT INTO stock_movements (tenant_id, item_id, location_id, batch_id, quantity,
                                        movement_type, reason, reference_kind, reference_id,
                                        balance_after, performed_by)
           VALUES ($1, $2, $3, $4, $5, 'dispense', $6, 'dispense', $7, 0, $8)
           RETURNING id`,
          [
            tenantId,
            stockItemId,
            input.locationId,
            batch.id,
            -take,
            `Dispensed on ${reference}`,
            dispenseId,
            principal.userId,
          ],
        );

        await db.query(
          `INSERT INTO dispense_items (tenant_id, dispense_id, prescription_item_id, item_id,
                                       batch_id, quantity, unit_price_cents,
                                       substituted_for_item_id, substitution_reason, stock_movement_id)
           VALUES ($1, $2, $3, $4, $5, $6,
                   (SELECT sale_price_cents FROM inventory_items WHERE id = $4),
                   $7, $8, $9)`,
          [
            tenantId,
            dispenseId,
            line.prescriptionItemId,
            stockItemId,
            batch.id,
            take,
            line.substituteItemId ? rxItem.item_id : null,
            line.substitutionReason ?? null,
            moveRows[0]!.id,
          ],
        );

        lines.push({
          medicationName: rxItem.medication_name,
          quantity: take,
          lotNumber: batch.lot_number,
          batchId: batch.id,
        });

        remaining -= take;
      }

      await db.query(
        `UPDATE prescription_items
            SET quantity_dispensed = quantity_dispensed + $2,
                status = CASE
                  WHEN quantity_dispensed + $2 >= quantity_prescribed THEN 'dispensed'
                  ELSE 'partially_dispensed'
                END
          WHERE id = $1`,
        [line.prescriptionItemId, quantity],
      );

      await raiseAlertsIfBreached(db, tenantId, stockItemId, input.locationId);
    }

    // The prescription is complete only when every line is.
    const { rows: statusRows } = await db.query<{ status: string }>(
      `UPDATE prescriptions p
          SET status = CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM prescription_items pi
               WHERE pi.prescription_id = p.id AND pi.status IN ('pending','partially_dispensed')
            ) THEN 'dispensed'
            ELSE 'partially_dispensed'
          END
        WHERE p.id = $1
        RETURNING status`,
      [input.prescriptionId],
    );

    collect({
      action: 'prescription.dispense',
      resourceType: 'dispense',
      resourceId: dispenseId,
      patientId: prescription.patient_id,
      touchedPhi: true,
      metadata: {
        reference,
        lineCount: lines.length,
        counsellingGiven: input.counsellingGiven,
        checkedBy: input.checkedBy ?? null,
      },
    });

    return {
      dispenseId,
      reference,
      lines,
      prescriptionStatus: statusRows[0]?.status ?? 'partially_dispensed',
    };
  });
}

/* ---------------------------------------------------------------------------
 * Low-stock alerting
 * ------------------------------------------------------------------------- */

/**
 * Raise an alert when an item crosses a threshold.
 *
 * The unique partial index `uq_stock_alert_open` makes this idempotent: one
 * open alert per item, location and type. Without it, every dispense below the
 * reorder level would notify the pharmacy manager again.
 */
async function raiseAlertsIfBreached(
  db: Queryable,
  tenantId: string,
  itemId: string,
  locationId: string,
): Promise<void> {
  const { rows } = await db.query<{
    name: string;
    base_unit: string;
    stock_state: string;
    quantity_available: string;
    reorder_level: string;
    critical_level: string;
    reorder_quantity: string;
    days_of_cover: string | null;
    location_name: string;
  }>(
    `SELECT name, base_unit, stock_state, quantity_available, reorder_level, critical_level,
            reorder_quantity, days_of_cover, location_name
       FROM v_stock_status
      WHERE item_id = $1 AND location_id = $2`,
    [itemId, locationId],
  );

  const status = rows[0];
  if (!status || status.stock_state === 'ok' || status.stock_state === 'overstocked') return;

  const alertType =
    status.stock_state === 'out_of_stock'
      ? 'out_of_stock'
      : status.stock_state === 'critical'
        ? 'critical_stock'
        : 'low_stock';

  const severity =
    alertType === 'out_of_stock' ? 'critical' : alertType === 'critical_stock' ? 'critical' : 'warning';

  const coverText = status.days_of_cover ? ` (about ${status.days_of_cover} days of cover)` : '';
  const message =
    alertType === 'out_of_stock'
      ? `${status.name} is out of stock at ${status.location_name}.`
      : `${status.name} is down to ${Number(status.quantity_available)} ${status.base_unit} at ${status.location_name}${coverText}. Reorder level is ${Number(status.reorder_level)}; suggested order ${Number(status.reorder_quantity)}.`;

  const { rows: inserted } = await db.query<{ id: string }>(
    `INSERT INTO stock_alerts (tenant_id, item_id, location_id, alert_type, severity,
                               quantity_at_alert, threshold, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (item_id, location_id, alert_type) WHERE status IN ('open','acknowledged')
       DO NOTHING
     RETURNING id`,
    [
      tenantId,
      itemId,
      locationId,
      alertType,
      severity,
      Number(status.quantity_available),
      alertType === 'low_stock' ? Number(status.reorder_level) : Number(status.critical_level),
      message,
    ],
  );

  // Only notify on a NEW alert, so a shortage pages someone once rather than
  // on every subsequent dispense.
  if (inserted.length > 0) {
    await db.query(
      `INSERT INTO notifications (tenant_id, channel, template_key, category, priority,
                                  subject, body, payload, dedupe_key)
       VALUES ($1, 'in_app', 'stock_alert', 'inventory', $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL
         DO NOTHING`,
      [
        tenantId,
        severity === 'critical' ? 2 : 5,
        `Stock alert: ${status.name}`,
        message,
        JSON.stringify({ itemId, locationId, alertType, stockState: status.stock_state }),
        `stock_alert:${inserted[0]!.id}`,
      ],
    );

    logger.warn({ itemId, locationId, alertType, name: status.name }, 'stock alert raised');
  }
}

/** Close open shortage alerts once a receipt brings the balance back up. */
async function resolveAlertsIfRecovered(
  db: Queryable,
  itemId: string,
  locationId: string,
): Promise<void> {
  await db.query(
    `UPDATE stock_alerts a
        SET status = 'resolved', resolved_at = now()
      WHERE a.item_id = $1 AND a.location_id = $2
        AND a.status IN ('open','acknowledged')
        AND a.alert_type IN ('low_stock','critical_stock','out_of_stock')
        AND EXISTS (
          SELECT 1 FROM v_stock_status v
           WHERE v.item_id = a.item_id AND v.location_id = a.location_id
             AND v.stock_state IN ('ok','overstocked')
        )`,
    [itemId, locationId],
  );
}

/**
 * The stores stock can move in and out of.
 *
 * Dispensing has to name the store it dispenses from — stock is held per
 * location, and FEFO picking happens within one — so a dispensing screen
 * cannot work without this list. `allows_controlled` is included because it is
 * the constraint a pharmacist needs before reaching for a controlled drug: the
 * ledger will refuse the movement from a store that is not authorised for one,
 * and refusing at the point of selection is kinder than refusing at the point
 * of dispense.
 */
export async function listLocations(req: Request): Promise<Array<Record<string, unknown>>> {
  return runInTenantReadOnly(req, async ({ db }) => {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT l.id, l.name, l.code, l.kind, l.allows_controlled, l.temperature_controlled,
              f.name AS facility_name,
              (SELECT count(*) FROM stock_batches b
                WHERE b.location_id = l.id AND b.status = 'available' AND b.quantity_on_hand > 0)
                AS batches_available
         FROM inventory_locations l
         LEFT JOIN facilities f ON f.id = l.facility_id
        WHERE l.is_active
        ORDER BY l.kind, l.name`,
    );

    return rows;
  });
}

export async function listAlerts(
  req: Request,
  input: { status?: string; severity?: string },
): Promise<Array<Record<string, unknown>>> {
  return runInTenantReadOnly(req, async ({ db }) => {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT a.id, a.alert_type, a.severity, a.message, a.status, a.created_at,
              a.quantity_at_alert, a.threshold,
              i.name AS item_name, i.sku, i.reorder_quantity,
              l.name AS location_name,
              s.name AS preferred_supplier
         FROM stock_alerts a
         JOIN inventory_items i ON i.id = a.item_id
         JOIN inventory_locations l ON l.id = a.location_id
         LEFT JOIN suppliers s ON s.id = i.preferred_supplier_id
        WHERE ($1::text IS NULL OR a.status = $1)
          AND ($2::text IS NULL OR a.severity = $2)
        ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                 a.created_at DESC
        LIMIT 200`,
      [input.status ?? 'open', input.severity ?? null],
    );

    return rows;
  });
}

/**
 * Nightly sweep. The per-write alerting above only fires on items that moved;
 * this catches thresholds crossed by a changed reorder level, and expiry
 * windows, which no stock movement would trigger.
 */
export async function scanForAlerts(db: Queryable, tenantId: string): Promise<number> {
  const { rows } = await db.query<{ item_id: string; location_id: string }>(
    `SELECT item_id, location_id FROM v_stock_status
      WHERE stock_state IN ('low','critical','out_of_stock')`,
  );

  for (const row of rows) {
    await raiseAlertsIfBreached(db, tenantId, row.item_id, row.location_id);
  }

  // Short-dated stock: raise once per batch, 90 days out, so there is time to
  // use it or return it to the supplier.
  const { rows: expiring } = await db.query<{ id: string }>(
    `INSERT INTO stock_alerts (tenant_id, item_id, location_id, alert_type, severity,
                               quantity_at_alert, message, batch_id)
     SELECT b.tenant_id, b.item_id, b.location_id,
            CASE WHEN b.expires_on <= CURRENT_DATE THEN 'expired' ELSE 'expiring_soon' END,
            CASE WHEN b.expires_on <= CURRENT_DATE + 30 THEN 'critical' ELSE 'warning' END,
            b.quantity_on_hand,
            format('%s lot %s (%s %s) expires on %s',
                   i.name, b.lot_number, b.quantity_on_hand, i.base_unit, b.expires_on),
            b.id
       FROM stock_batches b
       JOIN inventory_items i ON i.id = b.item_id
      WHERE b.status = 'available'
        AND b.quantity_on_hand > 0
        AND b.expires_on IS NOT NULL
        AND b.expires_on <= CURRENT_DATE + 90
     ON CONFLICT (item_id, location_id, alert_type) WHERE status IN ('open','acknowledged')
       DO NOTHING
     RETURNING id`,
  );

  // Mark anything already past its expiry date so it cannot be dispensed.
  await db.query(
    `UPDATE stock_batches
        SET status = 'expired'
      WHERE status = 'available'
        AND expires_on IS NOT NULL
        AND expires_on < CURRENT_DATE`,
  );

  return rows.length + expiring.length;
}
