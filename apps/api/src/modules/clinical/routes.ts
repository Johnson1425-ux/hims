/**
 * Clinical documentation (EHR/EMR).
 *
 * The signing endpoint is the one that matters: once an encounter is signed it
 * becomes a legal document, the database trigger refuses further edits to the
 * narrative, and corrections must be filed as amendments. See
 * migrations/0006_clinical_records.sql.
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
import { auditPhiRead } from '../../middleware/audit.js';
import { createHash } from 'node:crypto';

export const clinicalRoutes = Router();
clinicalRoutes.use(authenticate, requireStaffAccount());

const encounterIdParam = z.object({ encounterId: z.string().uuid() });

const createEncounterSchema = z.object({
  patientId: z.string().uuid(),
  appointmentId: z.string().uuid().optional(),
  encounterClass: z
    .enum(['ambulatory', 'emergency', 'inpatient', 'virtual', 'home', 'observation'])
    .default('ambulatory'),
  facilityId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  chiefComplaint: z.string().max(300).optional(),
});

const updateEncounterSchema = z.object({
  chiefComplaint: z.string().max(300).optional(),
  subjective: z.string().max(20_000).optional(),
  objective: z.string().max(20_000).optional(),
  assessment: z.string().max(20_000).optional(),
  plan: z.string().max(20_000).optional(),
  diagnosisCodes: z
    .array(z.object({ system: z.string().default('ICD10'), code: z.string().max(16), display: z.string().max(300) }))
    .max(20)
    .optional(),
  procedureCodes: z
    .array(z.object({ system: z.string().default('CPT'), code: z.string().max(16), display: z.string().max(300) }))
    .max(20)
    .optional(),
  followUpInDays: z.coerce.number().int().positive().max(3650).optional(),
  disposition: z
    .enum(['discharged_home', 'admitted', 'referred', 'transferred', 'left_without_being_seen', 'deceased'])
    .optional(),
});

const vitalsSchema = z.object({
  patientId: z.string().uuid(),
  encounterId: z.string().uuid().optional(),
  temperatureC: z.coerce.number().min(25).max(45).optional(),
  heartRateBpm: z.coerce.number().int().min(10).max(300).optional(),
  respiratoryRate: z.coerce.number().int().min(4).max(80).optional(),
  systolicMmhg: z.coerce.number().int().min(40).max(300).optional(),
  diastolicMmhg: z.coerce.number().int().min(20).max(200).optional(),
  oxygenSaturation: z.coerce.number().min(50).max(100).optional(),
  bloodGlucoseMmol: z.coerce.number().min(0.5).max(60).optional(),
  weightKg: z.coerce.number().min(0.3).max(500).optional(),
  heightCm: z.coerce.number().min(20).max(260).optional(),
  painScore: z.coerce.number().int().min(0).max(10).optional(),
  notes: z.string().max(1000).optional(),
});

const amendmentSchema = z.object({
  reason: z.string().min(10, 'Explain what is being corrected and why.').max(1000),
  narrative: z.string().max(20_000),
});

/**
 * NEWS2 early-warning score.
 *
 * Computed server-side so every surface — ward board, mobile, printed chart —
 * shows the same number from the same rules. A score of 5 or more is the
 * usual trigger for urgent clinical review.
 */
function news2(v: Record<string, number | undefined>): number {
  let score = 0;

  const band = (value: number | undefined, bands: Array<[number, number, number]>): number => {
    if (value === undefined) return 0;
    for (const [low, high, points] of bands) {
      if (value >= low && value <= high) return points;
    }
    return 0;
  };

  score += band(v.respiratoryRate, [[0, 8, 3], [9, 11, 1], [12, 20, 0], [21, 24, 2], [25, 999, 3]]);
  score += band(v.oxygenSaturation, [[0, 91, 3], [92, 93, 2], [94, 95, 1], [96, 100, 0]]);
  score += band(v.systolicMmhg, [[0, 90, 3], [91, 100, 2], [101, 110, 1], [111, 219, 0], [220, 999, 3]]);
  score += band(v.heartRateBpm, [[0, 40, 3], [41, 50, 1], [51, 90, 0], [91, 110, 1], [111, 130, 2], [131, 999, 3]]);
  score += band(v.temperatureC, [[0, 35, 3], [35.1, 36, 1], [36.1, 38, 0], [38.1, 39, 1], [39.1, 99, 2]]);

  return Math.min(20, score);
}

clinicalRoutes.post(
  '/',
  requirePermission('encounter:write'),
  validate({ body: createEncounterSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, createEncounterSchema);

      const result = await runInTenant(req, async ({ db, tenantId }, collect) => {
        const principal = req.principal!;
        await assertPatientAccess(db, principal, input.patientId);

        if (!principal.staffProfileId) {
          throw new AppError(403, 'FORBIDDEN', 'Only clinical staff can open an encounter.');
        }

        const { rows } = await db.query<{ id: string; reference: string; started_at: Date }>(
          `INSERT INTO encounters (tenant_id, reference, patient_id, appointment_id, provider_id,
                                   facility_id, department_id, encounter_class, chief_complaint,
                                   status, created_by)
           VALUES ($1, hims_util.allocate_reference($1, 'encounter', 'ENC'), $2, $3, $4,
                   $5, $6, $7, $8, 'in_progress', $9)
           RETURNING id, reference, started_at`,
          [
            tenantId,
            input.patientId,
            input.appointmentId ?? null,
            principal.staffProfileId,
            input.facilityId ?? null,
            input.departmentId ?? null,
            input.encounterClass,
            input.chiefComplaint ?? null,
            principal.userId,
          ],
        );

        // Opening an encounter establishes a treating relationship, which is
        // what later authorises this clinician to re-open the chart.
        await db.query(
          `INSERT INTO care_team_members (tenant_id, patient_id, staff_profile_id, relationship, added_by)
           VALUES ($1, $2, $3, 'treating', $4)
           ON CONFLICT DO NOTHING`,
          [tenantId, input.patientId, principal.staffProfileId, principal.userId],
        );

        if (input.appointmentId) {
          await db.query(
            `UPDATE appointments SET status = 'in_progress', started_at = now()
              WHERE id = $1 AND status IN ('checked_in','confirmed','scheduled')`,
            [input.appointmentId],
          );
        }

        collect({
          action: 'encounter.create',
          resourceType: 'encounter',
          resourceId: rows[0]!.id,
          patientId: input.patientId,
          touchedPhi: true,
          metadata: { encounterClass: input.encounterClass },
        });

        return rows[0]!;
      });

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  },
);

clinicalRoutes.patch(
  '/:encounterId',
  requirePermission('encounter:write'),
  validate({ params: encounterIdParam, body: updateEncounterSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, updateEncounterSchema);
      const encounterId = param(req, 'encounterId');

      const result = await runInTenant(req, async ({ db, tenantId }, collect) => {
        const principal = req.principal!;

        const { rows: existing } = await db.query<{ patient_id: string; status: string; provider_id: string }>(
          'SELECT patient_id, status, provider_id FROM encounters WHERE id = $1',
          [encounterId],
        );

        const encounter = existing[0];
        if (!encounter) throw new NotFoundError('encounter');
        await assertPatientAccess(db, principal, encounter.patient_id);

        // The database would refuse this anyway; checking here produces a far
        // better message than a constraint violation.
        if (['signed', 'amended', 'voided'].includes(encounter.status)) {
          throw new AppError(
            409,
            'RECORD_LOCKED',
            'This note is signed. File an amendment instead of editing it.',
          );
        }

        const { rows: keyRows } = await db.query<{ dek_wrapped: Buffer }>(
          'SELECT dek_wrapped FROM tenants WHERE id = $1',
          [tenantId],
        );
        const cipher = createFieldCipher(tenantId, keyRows[0]!.dek_wrapped);
        const ctx = (column: string) => ({ table: 'encounters', column, recordId: encounterId });

        const assignments: string[] = [];
        const params: unknown[] = [encounterId];
        const set = (col: string, value: unknown) => {
          params.push(value);
          assignments.push(`${col} = $${params.length}`);
        };

        if (input.chiefComplaint !== undefined) set('chief_complaint', input.chiefComplaint);
        // The SOAP narrative is the densest PHI in the system, so each section
        // is sealed individually.
        if (input.subjective !== undefined) {
          set('subjective_encrypted', cipher.encrypt(input.subjective, ctx('subjective_encrypted')));
        }
        if (input.objective !== undefined) {
          set('objective_encrypted', cipher.encrypt(input.objective, ctx('objective_encrypted')));
        }
        if (input.assessment !== undefined) {
          set('assessment_encrypted', cipher.encrypt(input.assessment, ctx('assessment_encrypted')));
        }
        if (input.plan !== undefined) {
          set('plan_encrypted', cipher.encrypt(input.plan, ctx('plan_encrypted')));
        }
        // Codes stay queryable: claims and reporting depend on them.
        if (input.diagnosisCodes !== undefined) set('diagnosis_codes', JSON.stringify(input.diagnosisCodes));
        if (input.procedureCodes !== undefined) set('procedure_codes', JSON.stringify(input.procedureCodes));
        if (input.followUpInDays !== undefined) set('follow_up_in_days', input.followUpInDays);
        if (input.disposition !== undefined) set('disposition', input.disposition);

        if (assignments.length === 0) {
          return { id: encounterId, updated: false };
        }

        await db.query(`UPDATE encounters SET ${assignments.join(', ')} WHERE id = $1`, params);

        collect({
          action: 'encounter.update',
          resourceType: 'encounter',
          resourceId: encounterId,
          patientId: encounter.patient_id,
          touchedPhi: true,
          // Section names only, never the clinical text itself.
          metadata: { sectionsEdited: Object.keys(input) },
        });

        return { id: encounterId, updated: true };
      });

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Sign an encounter.
 *
 * The signature is a SHA-256 over the serialised clinical content, stored on
 * the row. A later silent edit — by a bug, or by someone with direct database
 * access — no longer reconciles with it, which is what makes the attestation
 * mean something.
 */
clinicalRoutes.post(
  '/:encounterId/sign',
  requirePermission('encounter:sign'),
  validate({ params: encounterIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const encounterId = param(req, 'encounterId');

      const result = await runInTenant(req, async ({ db }, collect) => {
        const principal = req.principal!;
        if (!principal.staffProfileId) {
          throw new AppError(403, 'FORBIDDEN', 'Only a registered clinician can sign a note.');
        }

        const { rows } = await db.query<{
          patient_id: string;
          status: string;
          provider_id: string;
          chief_complaint: string | null;
          assessment_encrypted: Buffer | null;
          plan_encrypted: Buffer | null;
          diagnosis_codes: unknown;
        }>(
          `SELECT patient_id, status, provider_id, chief_complaint,
                  assessment_encrypted, plan_encrypted, diagnosis_codes
             FROM encounters WHERE id = $1`,
          [encounterId],
        );

        const encounter = rows[0];
        if (!encounter) throw new NotFoundError('encounter');

        if (encounter.status === 'signed') {
          throw new AppError(409, 'PRECONDITION_FAILED', 'This note is already signed.');
        }

        // Signing is a personal legal act: it attests to care the signer gave.
        if (encounter.provider_id !== principal.staffProfileId) {
          throw new AppError(
            403,
            'FORBIDDEN',
            'Only the clinician who authored this note can sign it. A supervisor can co-sign instead.',
          );
        }

        // An unassessed note is not a clinical record.
        if (!encounter.assessment_encrypted) {
          throw new AppError(
            422,
            'VALIDATION_FAILED',
            'Record an assessment before signing.',
          );
        }

        const signaturePayload = [
          encounterId,
          encounter.patient_id,
          principal.staffProfileId,
          encounter.chief_complaint ?? '',
          encounter.assessment_encrypted.toString('base64'),
          encounter.plan_encrypted?.toString('base64') ?? '',
          JSON.stringify(encounter.diagnosis_codes ?? []),
        ].join('|');

        const signatureHash = createHash('sha256').update(signaturePayload).digest();

        const { rows: signed } = await db.query<{ signed_at: Date }>(
          `UPDATE encounters
              SET status = 'signed', signed_by = $2, signed_at = now(),
                  signature_hash = $3,
                  ended_at = COALESCE(ended_at, now())
            WHERE id = $1
            RETURNING signed_at`,
          [encounterId, principal.staffProfileId, signatureHash],
        );

        // A signed encounter closes its appointment.
        await db.query(
          `UPDATE appointments a
              SET status = 'completed', completed_at = now()
            WHERE a.id = (SELECT appointment_id FROM encounters WHERE id = $1)
              AND a.status IN ('in_progress','checked_in')`,
          [encounterId],
        );

        collect({
          action: 'encounter.sign',
          resourceType: 'encounter',
          resourceId: encounterId,
          patientId: encounter.patient_id,
          touchedPhi: true,
          metadata: { signedBy: principal.staffProfileId, immutableFrom: signed[0]!.signed_at },
        });

        return { id: encounterId, status: 'signed', signedAt: signed[0]!.signed_at.toISOString() };
      });

      res.json({
        data: result,
        meta: { notice: 'This note is now part of the legal record. Changes must be filed as amendments.' },
      });
    } catch (error) {
      next(error);
    }
  },
);

clinicalRoutes.post(
  '/:encounterId/amendments',
  requirePermission('encounter:write'),
  validate({ params: encounterIdParam, body: amendmentSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, amendmentSchema);
      const encounterId = param(req, 'encounterId');

      const result = await runInTenant(req, async ({ db, tenantId }, collect) => {
        const principal = req.principal!;
        if (!principal.staffProfileId) {
          throw new AppError(403, 'FORBIDDEN', 'Only a registered clinician can amend a note.');
        }

        const { rows: enc } = await db.query<{ patient_id: string; status: string }>(
          'SELECT patient_id, status FROM encounters WHERE id = $1',
          [encounterId],
        );
        const encounter = enc[0];
        if (!encounter) throw new NotFoundError('encounter');

        if (!['signed', 'amended'].includes(encounter.status)) {
          throw new AppError(
            409,
            'PRECONDITION_FAILED',
            'Only a signed note needs an amendment. Edit the draft directly.',
          );
        }

        const { rows: keyRows } = await db.query<{ dek_wrapped: Buffer }>(
          'SELECT dek_wrapped FROM tenants WHERE id = $1',
          [tenantId],
        );
        const cipher = createFieldCipher(tenantId, keyRows[0]!.dek_wrapped);

        const { rows } = await db.query<{ id: string; sequence_no: number }>(
          `INSERT INTO encounter_amendments (tenant_id, encounter_id, sequence_no, reason,
                                             narrative_encrypted, authored_by)
           VALUES ($1, $2,
                   (SELECT COALESCE(max(sequence_no), 0) + 1 FROM encounter_amendments WHERE encounter_id = $2),
                   $3, $4, $5)
           RETURNING id, sequence_no`,
          [
            tenantId,
            encounterId,
            input.reason,
            cipher.encrypt(input.narrative, {
              table: 'encounter_amendments',
              column: 'narrative_encrypted',
              recordId: encounterId,
            }),
            principal.staffProfileId,
          ],
        );

        // The encounter moves to 'amended' so any reader knows to look for
        // the addendum rather than trusting the original in isolation.
        await db.query(`UPDATE encounters SET status = 'amended' WHERE id = $1`, [encounterId]);

        collect({
          action: 'encounter.amend',
          resourceType: 'encounter_amendment',
          resourceId: rows[0]!.id,
          patientId: encounter.patient_id,
          touchedPhi: true,
          metadata: { sequenceNo: rows[0]!.sequence_no, reason: input.reason },
        });

        return rows[0]!;
      });

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  },
);

clinicalRoutes.post(
  '/vitals',
  requirePermission('vitals:write'),
  validate({ body: vitalsSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, vitalsSchema);

      const result = await runInTenant(req, async ({ db, tenantId }, collect) => {
        const principal = req.principal!;
        await assertPatientAccess(db, principal, input.patientId);

        const score = news2({
          respiratoryRate: input.respiratoryRate,
          oxygenSaturation: input.oxygenSaturation,
          systolicMmhg: input.systolicMmhg,
          heartRateBpm: input.heartRateBpm,
          temperatureC: input.temperatureC,
        });

        const { rows } = await db.query<{ id: string; bmi: string | null }>(
          `INSERT INTO vital_signs (tenant_id, patient_id, encounter_id, recorded_by,
                                    temperature_c, heart_rate_bpm, respiratory_rate,
                                    systolic_mmhg, diastolic_mmhg, oxygen_saturation,
                                    blood_glucose_mmol, weight_kg, height_cm,
                                    pain_score, news2_score, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING id, bmi`,
          [
            tenantId,
            input.patientId,
            input.encounterId ?? null,
            principal.staffProfileId,
            input.temperatureC ?? null,
            input.heartRateBpm ?? null,
            input.respiratoryRate ?? null,
            input.systolicMmhg ?? null,
            input.diastolicMmhg ?? null,
            input.oxygenSaturation ?? null,
            input.bloodGlucoseMmol ?? null,
            input.weightKg ?? null,
            input.heightCm ?? null,
            input.painScore ?? null,
            score,
            input.notes ?? null,
          ],
        );

        // A deteriorating patient needs a person told, not a row written.
        if (score >= 5) {
          await db.query(
            `INSERT INTO notifications (tenant_id, patient_id, channel, template_key, category,
                                        priority, subject, body, payload, dedupe_key)
             VALUES ($1, $2, 'in_app', 'early_warning', 'clinical', 1, $3, $4, $5, $6)
             ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
            [
              tenantId,
              input.patientId,
              'Early warning score requires review',
              `NEWS2 score of ${score} recorded. Urgent clinical review indicated.`,
              JSON.stringify({ vitalSignId: rows[0]!.id, news2Score: score }),
              `news2:${rows[0]!.id}`,
            ],
          );
        }

        collect({
          action: 'vitals.record',
          resourceType: 'vital_signs',
          resourceId: rows[0]!.id,
          patientId: input.patientId,
          touchedPhi: true,
          metadata: { news2Score: score, escalated: score >= 5 },
        });

        return { id: rows[0]!.id, bmi: rows[0]!.bmi ? Number(rows[0]!.bmi) : null, news2Score: score };
      });

      res.status(201).json({
        data: result,
        meta:
          result.news2Score >= 5
            ? { warning: 'NEWS2 of 5 or more: urgent clinical review indicated.' }
            : undefined,
      });
    } catch (error) {
      next(error);
    }
  },
);

/** Full chart timeline for one patient. */
clinicalRoutes.get(
  '/patient/:patientId',
  requirePermission('encounter:read'),
  validate({ params: z.object({ patientId: z.string().uuid() }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = param(req, 'patientId');

      const result = await runInTenantReadOnly(req, async ({ db, tenantId }, collect) => {
        const principal = req.principal!;
        const decision = await assertPatientAccess(db, principal, patientId);

        const { rows: keyRows } = await db.query<{ dek_wrapped: Buffer }>(
          'SELECT dek_wrapped FROM tenants WHERE id = $1',
          [tenantId],
        );
        const cipher = createFieldCipher(tenantId, keyRows[0]!.dek_wrapped);

        const { rows } = await db.query<{
          id: string;
          reference: string;
          started_at: Date;
          ended_at: Date | null;
          encounter_class: string;
          status: string;
          chief_complaint: string | null;
          provider_name: string;
          subjective_encrypted: Buffer | null;
          objective_encrypted: Buffer | null;
          assessment_encrypted: Buffer | null;
          plan_encrypted: Buffer | null;
          diagnosis_codes: unknown;
          amendment_count: string;
        }>(
          `SELECT e.id, e.reference, e.started_at, e.ended_at, e.encounter_class, e.status,
                  e.chief_complaint, sp.display_name AS provider_name,
                  e.subjective_encrypted, e.objective_encrypted,
                  e.assessment_encrypted, e.plan_encrypted, e.diagnosis_codes,
                  (SELECT count(*) FROM encounter_amendments a WHERE a.encounter_id = e.id) AS amendment_count
             FROM encounters e
             JOIN staff_profiles sp ON sp.id = e.provider_id
            WHERE e.patient_id = $1
            ORDER BY e.started_at DESC
            LIMIT 50`,
          [patientId],
        );

        auditPhiRead(collect, {
          action: 'encounter.read',
          resourceType: 'encounter',
          patientId,
          basis: decision.basis,
        });

        return rows.map((row) => {
          const ctx = (column: string) => ({ table: 'encounters', column, recordId: row.id });
          return {
            id: row.id,
            reference: row.reference,
            startedAt: row.started_at.toISOString(),
            endedAt: row.ended_at?.toISOString() ?? null,
            encounterClass: row.encounter_class,
            status: row.status,
            chiefComplaint: row.chief_complaint,
            providerName: row.provider_name,
            subjective: cipher.decrypt(row.subjective_encrypted, ctx('subjective_encrypted')),
            objective: cipher.decrypt(row.objective_encrypted, ctx('objective_encrypted')),
            assessment: cipher.decrypt(row.assessment_encrypted, ctx('assessment_encrypted')),
            plan: cipher.decrypt(row.plan_encrypted, ctx('plan_encrypted')),
            diagnosisCodes: row.diagnosis_codes,
            amendmentCount: Number(row.amendment_count),
          };
        });
      });

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  },
);
