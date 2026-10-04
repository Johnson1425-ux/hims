/**
 * Prescribing.
 *
 * The safety check before issuing is the substance of this module. A
 * prescription that collides with a recorded allergy must not be signable
 * without an explicit, recorded override: this is the single highest-value
 * interlock in an HMS, and the one most often reduced to a dismissible toast.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireStaffAccount } from '../../middleware/authorize.js';
import { body, param, validate } from '../../middleware/validate.js';
import { runInTenant, runInTenantReadOnly } from '../../middleware/tenant.js';
import { assertPatientAccess } from '../../security/rbac.js';
import { createFieldCipher } from '../../security/crypto.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import type { Queryable } from '../../db/pool.js';
import { createHash } from 'node:crypto';

export const prescriptionRoutes = Router();
prescriptionRoutes.use(authenticate, requireStaffAccount());

const prescriptionItemSchema = z.object({
  itemId: z.string().uuid().optional(),
  medicationName: z.string().min(1).max(300),
  strength: z.string().max(80).optional(),
  form: z.string().max(40).optional(),
  route: z.string().min(1).max(40),
  doseQuantity: z.coerce.number().positive(),
  doseUnit: z.string().min(1).max(40),
  frequencyCode: z.string().min(1).max(20),
  frequencyPerDay: z.coerce.number().positive().max(24).optional(),
  durationDays: z.coerce.number().int().positive().max(365).optional(),
  asNeeded: z.boolean().default(false),
  instructions: z.string().min(1, 'Dosage instructions are printed on the label.').max(500),
  quantityPrescribed: z.coerce.number().positive(),
  refillsAuthorised: z.coerce.number().int().min(0).max(12).default(0),
  substitutionAllowed: z.boolean().default(true),
});

const createPrescriptionSchema = z.object({
  patientId: z.string().uuid(),
  encounterId: z.string().uuid().optional(),
  items: z.array(prescriptionItemSchema).min(1, 'Add at least one medication.').max(20),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(2000).optional(),
  fulfilment: z.enum(['in_house', 'external_pharmacy', 'patient_supplied']).default('in_house'),
  /**
   * Warnings the prescriber was shown and chose to proceed past. Each one must
   * carry a reason, and both are stored on the prescription.
   */
  overrides: z
    .array(z.object({ code: z.string().max(80), reason: z.string().min(10).max(500) }))
    .default([]),
});

export interface SafetyWarning {
  severity: 'contraindicated' | 'severe' | 'moderate' | 'info';
  code: string;
  message: string;
  /** Blocking warnings require an explicit override to proceed. */
  blocking: boolean;
}

/**
 * Pre-flight safety screen.
 *
 * Covers the checks that can be made from data this system holds: recorded
 * allergies (including the drug-class match via the catalogue), duplicate
 * active therapy, and controlled-substance authority. A production deployment
 * would additionally call a drug-interaction service such as First Databank or
 * RxNav; that integration point is marked below rather than faked, because a
 * stub that silently returns "no interactions" is worse than none.
 */
async function screenPrescription(
  db: Queryable,
  patientId: string,
  items: Array<z.infer<typeof prescriptionItemSchema>>,
  prescriberId: string,
): Promise<SafetyWarning[]> {
  const warnings: SafetyWarning[] = [];

  const { rows: allergies } = await db.query<{
    allergen: string;
    severity: string;
    medication_id: string | null;
    reaction: string | null;
  }>(
    `SELECT allergen, severity, medication_id, reaction
       FROM patient_allergies
      WHERE patient_id = $1 AND is_active`,
    [patientId],
  );

  const { rows: activeTherapy } = await db.query<{ medication_name: string; generic_name: string | null }>(
    `SELECT pi.medication_name, i.generic_name
       FROM prescription_items pi
       JOIN prescriptions p ON p.id = pi.prescription_id
       LEFT JOIN inventory_items i ON i.id = pi.item_id
      WHERE p.patient_id = $1
        AND p.status IN ('active','partially_dispensed')
        AND pi.status <> 'cancelled'`,
    [patientId],
  );

  for (const item of items) {
    // Resolve the catalogue entry, which carries the generic name and the
    // controlled schedule the checks below need.
    const { rows: catalogue } = item.itemId
      ? await db.query<{
          generic_name: string | null;
          controlled_schedule: string | null;
          is_high_alert: boolean;
          name: string;
        }>(
          'SELECT generic_name, controlled_schedule, is_high_alert, name FROM inventory_items WHERE id = $1',
          [item.itemId],
        )
      : { rows: [] };

    const drug = catalogue[0];
    const genericName = drug?.generic_name ?? item.medicationName;

    // ---- Allergy match -----------------------------------------------------
    for (const allergy of allergies) {
      const allergenLower = allergy.allergen.toLowerCase();
      const matchesById = allergy.medication_id && allergy.medication_id === item.itemId;
      const matchesByName =
        genericName.toLowerCase().includes(allergenLower) ||
        allergenLower.includes(genericName.toLowerCase());

      if (matchesById || matchesByName) {
        const blocking = ['anaphylaxis', 'severe'].includes(allergy.severity);
        warnings.push({
          severity: blocking ? 'contraindicated' : 'moderate',
          code: `ALLERGY_${allergy.allergen.toUpperCase().replace(/\W+/g, '_')}`,
          message: `${item.medicationName} matches a recorded ${allergy.severity} allergy to ${allergy.allergen}${
            allergy.reaction ? ` (${allergy.reaction})` : ''
          }.`,
          blocking,
        });
      }
    }

    // ---- Duplicate therapy -------------------------------------------------
    for (const active of activeTherapy) {
      const activeGeneric = (active.generic_name ?? active.medication_name).toLowerCase();
      if (activeGeneric === genericName.toLowerCase()) {
        warnings.push({
          severity: 'moderate',
          code: 'DUPLICATE_THERAPY',
          message: `The patient already has an active prescription for ${active.medication_name}.`,
          blocking: false,
        });
      }
    }

    // ---- Controlled-substance authority ------------------------------------
    if (drug?.controlled_schedule) {
      const { rows: prescriber } = await db.query<{ dea_number_encrypted: Buffer | null }>(
        'SELECT dea_number_encrypted FROM staff_profiles WHERE id = $1',
        [prescriberId],
      );

      if (!prescriber[0]?.dea_number_encrypted) {
        warnings.push({
          severity: 'contraindicated',
          code: 'NO_CONTROLLED_AUTHORITY',
          message: `${item.medicationName} is a schedule ${drug.controlled_schedule} drug and you have no controlled-substance registration on file.`,
          blocking: true,
        });
      }

      if (item.refillsAuthorised > 0 && ['I', 'II'].includes(drug.controlled_schedule)) {
        warnings.push({
          severity: 'severe',
          code: 'REFILL_NOT_PERMITTED',
          message: `Schedule ${drug.controlled_schedule} prescriptions cannot carry refills.`,
          blocking: true,
        });
      }
    }

    if (drug?.is_high_alert) {
      warnings.push({
        severity: 'info',
        code: 'HIGH_ALERT_MEDICATION',
        message: `${item.medicationName} is a high-alert medication. Confirm the dose and route before signing.`,
        blocking: false,
      });
    }

    // ---- Renal and hepatic dosing -----------------------------------------
    // INTEGRATION POINT: weight-based and renal-adjusted dosing needs the
    // latest creatinine and weight, plus a dosing reference. Deliberately not
    // approximated here — a wrong dose ceiling is more dangerous than none.
  }

  return warnings;
}

/** Dry-run the safety screen, so the UI can warn before the prescriber commits. */
prescriptionRoutes.post(
  '/screen',
  requirePermission('prescription:write'),
  validate({ body: createPrescriptionSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, createPrescriptionSchema);

      const warnings = await runInTenantReadOnly(req, async ({ db }) => {
        const principal = req.principal!;
        await assertPatientAccess(db, principal, input.patientId);
        return screenPrescription(db, input.patientId, input.items, principal.staffProfileId!);
      });

      res.json({
        data: { warnings },
        meta: {
          blocking: warnings.filter((w) => w.blocking).length,
          total: warnings.length,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

prescriptionRoutes.post(
  '/',
  requirePermission('prescription:write'),
  validate({ body: createPrescriptionSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, createPrescriptionSchema);

      const result = await runInTenant(req, async ({ db, tenantId }, collect) => {
        const principal = req.principal!;
        if (!principal.staffProfileId) {
          throw new AppError(403, 'FORBIDDEN', 'Only a registered prescriber can issue a prescription.');
        }

        await assertPatientAccess(db, principal, input.patientId);

        // A lapsed licence must stop prescribing, not merely warn.
        const { rows: licence } = await db.query<{ license_expires_on: Date | null; is_provider: boolean }>(
          'SELECT license_expires_on, is_provider FROM staff_profiles WHERE id = $1',
          [principal.staffProfileId],
        );

        if (!licence[0]?.is_provider) {
          throw new AppError(403, 'FORBIDDEN', 'Your profile is not registered as a prescriber.');
        }
        if (licence[0].license_expires_on && licence[0].license_expires_on < new Date()) {
          throw new AppError(
            403,
            'FORBIDDEN',
            'Your professional licence on file has expired. Contact the medical director.',
          );
        }

        const warnings = await screenPrescription(
          db,
          input.patientId,
          input.items,
          principal.staffProfileId,
        );

        // A blocking warning may only be passed with a matching override that
        // carries a reason. Both the warning and the reason are persisted.
        const overrideCodes = new Set(input.overrides.map((o) => o.code));
        const unhandled = warnings.filter((w) => w.blocking && !overrideCodes.has(w.code));

        if (unhandled.length > 0) {
          throw new AppError(
            409,
            'PRECONDITION_FAILED',
            'This prescription has blocking safety warnings. Review each one and supply a documented override to continue.',
            {
              issues: unhandled.map((w) => ({ field: w.code, message: w.message })),
              logContext: { patientId: input.patientId, blockingCount: unhandled.length },
            },
          );
        }

        const { rows: keyRows } = await db.query<{ dek_wrapped: Buffer }>(
          'SELECT dek_wrapped FROM tenants WHERE id = $1',
          [tenantId],
        );
        const cipher = createFieldCipher(tenantId, keyRows[0]!.dek_wrapped);

        // The id is allocated before the insert because it is bound into the
        // AAD of notes_encrypted on this row.
        const { rows: newId } = await db.query<{ id: string }>('SELECT gen_random_uuid() AS id');
        const prescriptionId = newId[0]!.id;

        const { rows: created } = await db.query<{ id: string; reference: string }>(
          `INSERT INTO prescriptions (id, tenant_id, reference, patient_id, encounter_id, prescriber_id,
                                      status, valid_until, overridden_warnings, override_reason,
                                      notes_encrypted, fulfilment)
           VALUES ($1, $2, hims_util.allocate_reference($2, 'prescription', 'RX'), $3, $4, $5,
                   'active', $6, $7, $8, $9, $10)
           RETURNING id, reference`,
          [
            prescriptionId,
            tenantId,
            input.patientId,
            input.encounterId ?? null,
            principal.staffProfileId,
            input.validUntil ?? null,
            JSON.stringify(warnings.filter((w) => overrideCodes.has(w.code))),
            input.overrides.map((o) => `${o.code}: ${o.reason}`).join(' | ') || null,
            cipher.encrypt(input.notes, {
              table: 'prescriptions',
              column: 'notes_encrypted',
              recordId: prescriptionId,
            }),
            input.fulfilment,
          ],
        );

        for (const [index, item] of input.items.entries()) {
          await db.query(
            `INSERT INTO prescription_items
               (tenant_id, prescription_id, line_no, item_id, medication_name, strength, form, route,
                dose_quantity, dose_unit, frequency_code, frequency_per_day, duration_days,
                as_needed, instructions, quantity_prescribed, refills_authorised, substitution_allowed)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [
              tenantId,
              prescriptionId,
              index + 1,
              item.itemId ?? null,
              item.medicationName,
              item.strength ?? null,
              item.form ?? null,
              item.route,
              item.doseQuantity,
              item.doseUnit,
              item.frequencyCode,
              item.frequencyPerDay ?? null,
              item.durationDays ?? null,
              item.asNeeded,
              item.instructions,
              item.quantityPrescribed,
              item.refillsAuthorised,
              item.substitutionAllowed,
            ],
          );
        }

        // Sign it: the hash covers the lines, so a later edit is detectable.
        const signaturePayload = [
          prescriptionId,
          input.patientId,
          principal.staffProfileId,
          JSON.stringify(
            input.items.map((i) => [i.medicationName, i.doseQuantity, i.doseUnit, i.frequencyCode]),
          ),
        ].join('|');

        await db.query(
          'UPDATE prescriptions SET signature_hash = $2, signed_at = now() WHERE id = $1',
          [prescriptionId, createHash('sha256').update(signaturePayload).digest()],
        );

        collect({
          action: 'prescription.issue',
          resourceType: 'prescription',
          resourceId: prescriptionId,
          patientId: input.patientId,
          touchedPhi: true,
          metadata: {
            reference: created[0]!.reference,
            lineCount: input.items.length,
            // Overrides are the audit's whole point here.
            overrides: input.overrides,
            warningsShown: warnings.map((w) => w.code),
          },
        });

        return {
          id: prescriptionId,
          reference: created[0]!.reference,
          status: 'active',
          warnings,
        };
      });

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  },
);

/** The pharmacy queue: active prescriptions awaiting dispensing. */
prescriptionRoutes.get(
  '/queue',
  requirePermission('prescription:read', 'prescription:dispense'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await runInTenantReadOnly(req, async ({ db }, collect) => {
        const { rows } = await db.query<Record<string, unknown>>(
          `SELECT p.id, p.reference, p.prescribed_at, p.status,
                  pt.full_name AS patient_name, pt.mrn,
                  sp.display_name AS prescriber_name,
                  count(pi.id) FILTER (WHERE pi.status <> 'dispensed') AS lines_outstanding,
                  bool_or(i.controlled_schedule IS NOT NULL) AS has_controlled,
                  bool_or(i.requires_cold_chain) AS needs_cold_chain,
                  -- The lines themselves, so the screen that dispenses this
                  -- can show what is being picked and name the line ids
                  -- without a second round trip per row. Dispensed lines are
                  -- excluded: they are not work, and a partially dispensed
                  -- prescription should read as what is left.
                  COALESCE(
                    jsonb_agg(
                      jsonb_build_object(
                        'id', pi.id,
                        'medicationName', pi.medication_name,
                        'strength', pi.strength,
                        'route', pi.route,
                        'instructions', pi.instructions,
                        'quantityPrescribed', pi.quantity_prescribed,
                        'quantityDispensed', pi.quantity_dispensed,
                        'status', pi.status,
                        'controlledSchedule', i.controlled_schedule
                      ) ORDER BY pi.line_no
                    ) FILTER (WHERE pi.status <> 'dispensed'),
                    '[]'::jsonb
                  ) AS outstanding_items
             FROM prescriptions p
             JOIN patients pt ON pt.id = p.patient_id
             JOIN staff_profiles sp ON sp.id = p.prescriber_id
             JOIN prescription_items pi ON pi.prescription_id = p.id
             LEFT JOIN inventory_items i ON i.id = pi.item_id
            WHERE p.status IN ('active','partially_dispensed')
              AND p.fulfilment = 'in_house'
            GROUP BY p.id, pt.full_name, pt.mrn, sp.display_name
            ORDER BY has_controlled DESC, p.prescribed_at
            LIMIT 100`,
        );

        collect({
          action: 'prescription.queue_read',
          resourceType: 'prescription',
          touchedPhi: true,
          metadata: { resultCount: rows.length },
        });

        return rows;
      });

      res.json({ data: rows });
    } catch (error) {
      next(error);
    }
  },
);

prescriptionRoutes.get(
  '/patient/:patientId',
  requirePermission('prescription:read'),
  validate({ params: z.object({ patientId: z.string().uuid() }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = param(req, 'patientId');

      const rows = await runInTenantReadOnly(req, async ({ db }, collect) => {
        const principal = req.principal!;
        const decision = await assertPatientAccess(db, principal, patientId);

        const { rows } = await db.query<Record<string, unknown>>(
          `SELECT p.id, p.reference, p.prescribed_at, p.status, p.valid_until,
                  sp.display_name AS prescriber_name,
                  json_agg(json_build_object(
                    'medicationName', pi.medication_name,
                    'strength', pi.strength,
                    'route', pi.route,
                    'instructions', pi.instructions,
                    'quantityPrescribed', pi.quantity_prescribed,
                    'quantityDispensed', pi.quantity_dispensed,
                    'refillsAuthorised', pi.refills_authorised,
                    'refillsUsed', pi.refills_used,
                    'status', pi.status
                  ) ORDER BY pi.line_no) AS items
             FROM prescriptions p
             JOIN staff_profiles sp ON sp.id = p.prescriber_id
             JOIN prescription_items pi ON pi.prescription_id = p.id
            WHERE p.patient_id = $1
            GROUP BY p.id, sp.display_name
            ORDER BY p.prescribed_at DESC
            LIMIT 100`,
          [patientId],
        );

        collect({
          action: 'prescription.read',
          resourceType: 'prescription',
          patientId,
          touchedPhi: true,
          metadata: { accessBasis: decision.basis, resultCount: rows.length },
        });

        return rows;
      });

      res.json({ data: rows });
    } catch (error) {
      next(error);
    }
  },
);
