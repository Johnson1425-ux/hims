/**
 * Patient service.
 *
 * Holds the rules that are neither validation (schemas.ts) nor persistence
 * (repository.ts): duplicate handling on registration, the access decision and
 * its audit consequence, and break-glass.
 */
import type { Request } from 'express';
import type { Queryable } from '../../db/pool.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { createFieldCipher } from '../../security/crypto.js';
import { assertPatientAccess, type Principal } from '../../security/rbac.js';
import { auditPhiRead, summariseChanges } from '../../middleware/audit.js';
import { runInTenant, runInTenantReadOnly } from '../../middleware/tenant.js';
import { logger } from '../../utils/logger.js';
import * as repo from './repository.js';
import type { CreatePatientInput, SearchPatientsInput, UpdatePatientInput } from './schemas.js';

async function cipherFor(db: Queryable, tenantId: string) {
  const wrapped = await repo.loadTenantKey(db, tenantId);
  return createFieldCipher(tenantId, wrapped);
}

export interface RegistrationResult {
  patient: repo.PatientDetail;
  /** Populated when registration proceeded despite near-matches. */
  duplicatesAcknowledged: repo.DuplicateCandidate[];
}

/**
 * Register a patient.
 *
 * Refuses with 409 and the candidate list when a possible duplicate exists and
 * the caller has not acknowledged it. Merging two charts after the fact is
 * expensive and error-prone, so the friction belongs here.
 */
export async function registerPatient(
  req: Request,
  input: CreatePatientInput,
): Promise<RegistrationResult> {
  const principal = req.principal!;

  return runInTenant(req, async ({ db, tenantId }, collect) => {
    const candidates = await repo.findDuplicateCandidates(db, tenantId, {
      givenName: input.givenName,
      familyName: input.familyName,
      dateOfBirth: input.dateOfBirth,
      nationalId: input.nationalId,
      phone: input.phone,
      email: input.email,
    });

    // An exact national-ID match is never a different person. That one cannot
    // be waved through, whatever the caller acknowledges.
    const exact = candidates.filter((c) => c.confidence === 'exact');
    if (exact.length > 0) {
      throw new AppError(
        409,
        'DUPLICATE_PATIENT',
        'A patient with this national ID is already registered. Open the existing record instead.',
        { logContext: { existingPatientIds: exact.map((c) => c.id) } },
      );
    }

    if (candidates.length > 0 && !input.acknowledgeDuplicates) {
      throw new AppError(
        409,
        'DUPLICATE_PATIENT',
        'This may be an existing patient. Review the matches, then resubmit with acknowledgement if it is a new person.',
        {
          issues: candidates.map((c) => ({
            field: 'duplicateCandidate',
            message: `${c.fullName} (${c.mrn}), born ${c.dateOfBirth} — matched on ${c.matchedOn.join(', ')}`,
          })),
          logContext: { candidateCount: candidates.length },
        },
      );
    }

    const cipher = await cipherFor(db, tenantId);
    const row = await repo.insertPatient(db, tenantId, input, cipher, principal.userId);

    // A newly registered patient's primary provider is implicitly on the care
    // team; without this the provider cannot open the chart they just created.
    if (input.primaryProviderId) {
      await db.query(
        `INSERT INTO care_team_members (tenant_id, patient_id, staff_profile_id, relationship, added_by)
         VALUES ($1, $2, $3, 'primary', $4)
         ON CONFLICT DO NOTHING`,
        [tenantId, row.id, input.primaryProviderId, principal.userId],
      );
    }

    collect({
      action: 'patient.register',
      resourceType: 'patient',
      resourceId: row.id,
      patientId: row.id,
      touchedPhi: true,
      // Field names only. The audit log must not become a second copy of the PHI.
      changes: summariseChanges(null, {
        mrn: row.mrn,
        registrationSource: input.registrationSource,
        hasNationalId: Boolean(input.nationalId),
        hasInsurance: false,
      }),
      metadata: {
        duplicatesAcknowledged: candidates.length,
      },
    });

    if (candidates.length > 0) {
      logger.warn(
        { patientId: row.id, candidates: candidates.map((c) => c.id) },
        'patient registered over acknowledged duplicate candidates',
      );
    }

    return {
      patient: repo.toDetail(row, cipher, null),
      duplicatesAcknowledged: candidates,
    };
  });
}

/**
 * Read one chart.
 *
 * The relationship check runs before the row is returned, and its BASIS is
 * written to the audit trail. "Dr. Okafor opened this chart" is not an answer
 * in an investigation; "as the named treating provider" is.
 */
export async function getPatient(req: Request, patientId: string): Promise<{
  patient: repo.PatientDetail;
  clinical: Awaited<ReturnType<typeof repo.loadClinicalSummary>>;
  accessBasis: string;
}> {
  return runInTenant(req, async ({ db, tenantId }, collect) => {
    const principal = req.principal!;
    const decision = await assertPatientAccess(db, principal, patientId);

    const row = await repo.findById(db, patientId);
    if (!row) throw new NotFoundError('patient');

    const cipher = await cipherFor(db, tenantId);
    const clinical = await repo.loadClinicalSummary(db, patientId);

    auditPhiRead(collect, {
      action: 'patient.read',
      resourceType: 'patient',
      resourceId: patientId,
      patientId,
      basis: decision.basis,
    });

    return {
      patient: repo.toDetail(row, cipher, row.last_seen_at),
      clinical,
      accessBasis: decision.basis,
    };
  });
}

/**
 * Search the roster.
 *
 * Audited as a single `patient.search` event carrying the result count rather
 * than one read per row: a 25-row page should not produce 25 audit entries,
 * but an insider pulling 4,000 results across an afternoon should still be
 * visible in the trail.
 */
export async function searchPatients(
  req: Request,
  input: SearchPatientsInput,
): Promise<{ items: repo.PatientSummary[]; total: number; page: number; pageSize: number }> {
  return runInTenantReadOnly(req, async ({ db, tenantId }, collect) => {
    const { rows, total } = await repo.searchPatients(db, tenantId, input);
    const cipher = await cipherFor(db, tenantId);

    collect({
      action: 'patient.search',
      resourceType: 'patient',
      touchedPhi: true,
      metadata: {
        resultCount: rows.length,
        totalMatches: total,
        // Which criteria were used, never the values typed in.
        criteria: Object.entries(input)
          .filter(([k, v]) => v !== undefined && !['page', 'pageSize', 'sort'].includes(k))
          .map(([k]) => k),
      },
    });

    return {
      items: rows.map((row) => repo.toSummary(row, cipher, row.last_seen_at)),
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  });
}

export async function updatePatient(
  req: Request,
  patientId: string,
  input: UpdatePatientInput,
): Promise<repo.PatientDetail> {
  return runInTenant(req, async ({ db, tenantId }, collect) => {
    const principal = req.principal!;
    const decision = await assertPatientAccess(db, principal, patientId);

    const before = await repo.findById(db, patientId);
    if (!before) throw new NotFoundError('patient');

    const cipher = await cipherFor(db, tenantId);
    const after = await repo.updatePatient(db, tenantId, patientId, input, cipher);
    if (!after) throw new NotFoundError('patient');

    // Compare only the fields the caller actually sent, so a PATCH does not
    // report the whole record as having changed. summariseChanges() reduces
    // the direct identifiers among them to `{ changed: true }`.
    const previousDetail = repo.toDetail(before, cipher, before.last_seen_at) as unknown as Record<
      string,
      unknown
    >;
    const touchedKeys = Object.keys(input) as Array<keyof typeof input>;
    const beforeSubset = Object.fromEntries(touchedKeys.map((k) => [k, previousDetail[k as string]]));

    collect({
      action: 'patient.update',
      resourceType: 'patient',
      resourceId: patientId,
      patientId,
      touchedPhi: true,
      changes: summariseChanges(beforeSubset, input as Record<string, unknown>),
      metadata: { accessBasis: decision.basis },
    });

    return repo.toDetail(after, cipher, before.last_seen_at);
  });
}

/**
 * Grant emergency access to a chart outside a care relationship.
 *
 * Granted immediately — a patient is in front of the clinician and arguing
 * about authorisation is the wrong failure mode — then queued for mandatory
 * review by the privacy officer. The justification minimum length is enforced
 * by a database CHECK as well as by the schema, because this is the field that
 * makes the later review possible.
 */
export async function grantBreakGlassAccess(
  req: Request,
  input: { patientId: string; justification: string; durationHours: number },
): Promise<{ expiresAt: string }> {
  return runInTenant(req, async ({ db, tenantId }, collect) => {
    const principal = req.principal!;

    const { rows: exists } = await db.query<{ id: string }>(
      'SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL',
      [input.patientId],
    );
    if (exists.length === 0) throw new NotFoundError('patient');

    const { rows } = await db.query<{ expires_at: Date }>(
      `INSERT INTO break_glass_grants (tenant_id, user_id, patient_id, justification, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))
       RETURNING expires_at`,
      [tenantId, principal.userId, input.patientId, input.justification, input.durationHours],
    );

    collect({
      action: 'patient.break_glass_granted',
      resourceType: 'patient',
      resourceId: input.patientId,
      patientId: input.patientId,
      touchedPhi: true,
      metadata: {
        durationHours: input.durationHours,
        // The justification is the point of the record, so it is retained in
        // full here. It is staff-authored text about clinical need, not PHI
        // about the patient.
        justification: input.justification,
        requiresPrivacyReview: true,
      },
    });

    logger.warn(
      { userId: principal.userId, patientId: input.patientId, durationHours: input.durationHours },
      'BREAK-GLASS access granted; queued for privacy review',
    );

    return { expiresAt: rows[0]!.expires_at.toISOString() };
  });
}

export async function addAllergy(
  req: Request,
  patientId: string,
  input: {
    allergen: string;
    allergenKind: string;
    medicationId?: string;
    reaction?: string;
    severity: string;
    onsetOn?: string;
  },
): Promise<{ id: string }> {
  return runInTenant(req, async ({ db, tenantId }, collect) => {
    const principal = req.principal!;
    await assertPatientAccess(db, principal, patientId);

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO patient_allergies
         (tenant_id, patient_id, allergen, allergen_kind, medication_id, reaction, severity,
          onset_on, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        tenantId,
        patientId,
        input.allergen,
        input.allergenKind,
        input.medicationId ?? null,
        input.reaction ?? null,
        input.severity,
        input.onsetOn ?? null,
        principal.userId,
      ],
    );

    collect({
      action: 'patient.allergy_added',
      resourceType: 'patient_allergy',
      resourceId: rows[0]!.id,
      patientId,
      touchedPhi: true,
      // Allergen and severity are recorded in full: this is a safety-critical
      // change and the trail needs to show what was asserted.
      metadata: { allergen: input.allergen, severity: input.severity },
    });

    return { id: rows[0]!.id };
  });
}
