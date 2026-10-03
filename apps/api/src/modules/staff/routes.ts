/**
 * Staff directory and role administration.
 *
 * The privilege-escalation guard is in `assertCanGrantRole`: a hospital admin
 * cannot mint a platform operator, and nobody can grant a role outranking
 * their own. Without it, "staff:write" would quietly be "become anyone".
 */
import { Router } from 'express';
import { z } from 'zod';
import { booleanish } from '../../utils/schema.js';
import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission, requireStaffAccount } from '../../middleware/authorize.js';
import { body, param, queryParams, validate } from '../../middleware/validate.js';
import { runInTenant, runInTenantReadOnly } from '../../middleware/tenant.js';
import { assertCanGrantRole, ROLE_KEYS, type RoleKey } from '../../security/rbac.js';
import { blindIndex, createFieldCipher, randomToken, sha256 } from '../../security/crypto.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { env } from '../../config/env.js';

export const staffRoutes = Router();
staffRoutes.use(authenticate, requireStaffAccount());

const inviteStaffSchema = z.object({
  email: z.string().email().max(320),
  fullName: z.string().min(2).max(200),
  givenName: z.string().min(1).max(120),
  familyName: z.string().min(1).max(120),
  title: z.string().max(40).optional(),
  phone: z.string().max(40).optional(),
  roles: z.array(z.enum(ROLE_KEYS)).min(1, 'Assign at least one role.'),
  employmentType: z
    .enum(['permanent', 'contract', 'locum', 'resident', 'volunteer'])
    .default('permanent'),
  isProvider: z.boolean().default(false),
  specialties: z.array(z.string().max(80)).max(10).default([]),
  primaryDepartmentId: z.string().uuid().optional(),
  primaryFacilityId: z.string().uuid().optional(),
  npiNumber: z.string().max(20).optional(),
  licenseNumber: z.string().max(60).optional(),
  licenseAuthority: z.string().max(120).optional(),
  licenseExpiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  defaultSlotMinutes: z.coerce.number().int().min(5).max(240).default(20),
  consultationFeeCents: z.coerce.number().int().min(0).default(0),
  facilityIds: z.array(z.string().uuid()).max(20).default([]),
});

const listStaffSchema = z.object({
  q: z.string().max(120).optional(),
  role: z.enum(ROLE_KEYS).optional(),
  departmentId: z.string().uuid().optional(),
  facilityId: z.string().uuid().optional(),
  providersOnly: booleanish().optional(),
  includeInactive: booleanish().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Invite a member of staff.
 *
 * No password is set here. The account is created in `invited` state with a
 * single-use token, and the invitee chooses their own credential. An admin who
 * never knows a colleague's password cannot act as them, which keeps the audit
 * trail attributable.
 */
staffRoutes.post(
  '/',
  requirePermission('staff:write'),
  validate({ body: inviteStaffSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, inviteStaffSchema);

      const result = await runInTenant(req, async ({ db, tenantId }, collect) => {
        const principal = req.principal!;

        // Refuse before writing anything if any requested role outranks the
        // inviter's own authority.
        for (const role of input.roles) {
          assertCanGrantRole(principal, role as RoleKey);
        }

        // A provider with no licence on file cannot prescribe, so the omission
        // is caught at invitation rather than at the first prescription.
        if (input.isProvider && !input.licenseNumber) {
          throw new AppError(
            422,
            'VALIDATION_FAILED',
            'A clinician profile needs a professional licence number.',
          );
        }

        const { rows: keyRows } = await db.query<{ dek_wrapped: Buffer }>(
          'SELECT dek_wrapped FROM tenants WHERE id = $1',
          [tenantId],
        );
        const cipher = createFieldCipher(tenantId, keyRows[0]!.dek_wrapped);

        // Both ids are allocated before any encryption, because each row's id
        // is bound into the AAD of that row's encrypted columns.
        const { rows: newIds } = await db.query<{ user_id: string; profile_id: string }>(
          'SELECT gen_random_uuid() AS user_id, gen_random_uuid() AS profile_id',
        );
        const { user_id: userId, profile_id: profileId } = newIds[0]!;

        await db.query(
          `INSERT INTO users (id, tenant_id, email, full_name, phone_encrypted, phone_blind_index,
                              status, must_change_password)
           VALUES ($1, $2, $3, $4, $5, $6, 'invited', false)`,
          [
            userId,
            tenantId,
            input.email,
            input.fullName,
            cipher.encrypt(input.phone, {
              table: 'users',
              column: 'phone_encrypted',
              recordId: userId,
            }),
            blindIndex(tenantId, 'user.phone', input.phone),
          ],
        );

        const { rows: profileRows } = await db.query<{ id: string; staff_number: string }>(
          `INSERT INTO staff_profiles (id, tenant_id, user_id, staff_number, title, given_name, family_name,
                                       employment_type, primary_department_id, primary_facility_id,
                                       is_provider, specialties, license_number_encrypted,
                                       license_authority, license_expires_on, npi_number,
                                       default_slot_minutes, consultation_fee_cents, hired_on)
           VALUES ($1, $2, $3, hims_util.allocate_reference($2, 'staff', 'STF'), $4, $5, $6,
                   $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, CURRENT_DATE)
           RETURNING id, staff_number`,
          [
            profileId,
            tenantId,
            userId,
            input.title ?? null,
            input.givenName,
            input.familyName,
            input.employmentType,
            input.primaryDepartmentId ?? null,
            input.primaryFacilityId ?? null,
            input.isProvider,
            input.specialties,
            cipher.encrypt(input.licenseNumber, {
              table: 'staff_profiles',
              column: 'license_number_encrypted',
              recordId: profileId,
            }),
            input.licenseAuthority ?? null,
            input.licenseExpiresOn ?? null,
            input.npiNumber ?? null,
            input.defaultSlotMinutes,
            input.consultationFeeCents,
          ],
        );

        for (const roleKey of input.roles) {
          await db.query(
            `INSERT INTO user_roles (user_id, role_id, granted_by)
             SELECT $1, r.id, $3
               FROM roles r
              WHERE r.key = $2 AND (r.tenant_id IS NULL OR r.tenant_id = $4)
              ORDER BY r.tenant_id NULLS LAST
              LIMIT 1
             ON CONFLICT DO NOTHING`,
            [userId, roleKey, principal.userId, tenantId],
          );
        }

        for (const facilityId of input.facilityIds) {
          await db.query(
            `INSERT INTO staff_facility_assignments (staff_profile_id, facility_id, is_primary)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [profileRows[0]!.id, facilityId, facilityId === input.primaryFacilityId],
          );
        }

        // Single-use invitation token, queued with the email in one transaction.
        const inviteToken = randomToken(32);
        await db.query(
          `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
           VALUES ($1, 'invitation', $2, now() + interval '7 days')`,
          [userId, sha256(inviteToken)],
        );

        await db.query(
          `INSERT INTO notifications (tenant_id, user_id, channel, template_key, subject,
                                      payload, category, priority, dedupe_key)
           VALUES ($1, $2, 'email', 'staff_invitation', 'You have been invited to the hospital system',
                   $3, 'security', 3, $4)`,
          [
            tenantId,
            userId,
            JSON.stringify({
              inviteUrl: `${env.WEB_BASE_URL}/accept-invitation?token=${inviteToken}`,
              fullName: input.fullName,
            }),
            `invite:${userId}`,
          ],
        );

        collect({
          action: 'staff.invite',
          resourceType: 'user',
          resourceId: userId,
          metadata: {
            staffNumber: profileRows[0]!.staff_number,
            roles: input.roles,
            isProvider: input.isProvider,
            invitedBy: principal.userId,
          },
        });

        return {
          userId,
          staffProfileId: profileRows[0]!.id,
          staffNumber: profileRows[0]!.staff_number,
          status: 'invited',
        };
      });

      res.status(201).json({
        data: result,
        meta: { notice: 'An invitation email has been queued. The link expires in 7 days.' },
      });
    } catch (error) {
      next(error);
    }
  },
);

staffRoutes.get(
  '/',
  requirePermission('staff:read'),
  validate({ query: listStaffSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = queryParams(req, listStaffSchema);

      const result = await runInTenantReadOnly(req, async ({ db }) => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        const where = (sql: string, value: unknown) => {
          params.push(value);
          conditions.push(sql.replace('$?', `$${params.length}`));
        };

        if (!query.includeInactive) conditions.push('sp.is_active');
        if (query.providersOnly) conditions.push('sp.is_provider');
        if (query.departmentId) where('sp.primary_department_id = $?', query.departmentId);
        if (query.facilityId) {
          where(
            `(sp.primary_facility_id = $? OR EXISTS (
               SELECT 1 FROM staff_facility_assignments sfa
                WHERE sfa.staff_profile_id = sp.id AND sfa.facility_id = $?))`,
            query.facilityId,
          );
        }
        if (query.q) {
          params.push(query.q);
          conditions.push(`sp.display_name ILIKE '%' || $${params.length} || '%'`);
        }
        if (query.role) {
          params.push(query.role);
          conditions.push(`EXISTS (
            SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = sp.user_id AND r.key = $${params.length})`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const offset = (query.page - 1) * query.pageSize;

        const [{ rows }, { rows: countRows }] = await Promise.all([
          db.query<Record<string, unknown>>(
            `SELECT sp.id, sp.staff_number, sp.display_name, sp.title, sp.given_name, sp.family_name,
                    sp.is_provider, sp.specialties, sp.employment_type, sp.is_active,
                    sp.license_expires_on, sp.default_slot_minutes, sp.accepts_new_patients,
                    d.name AS department_name, f.name AS facility_name,
                    u.email, u.status AS account_status, u.last_login_at,
                    (SELECT array_agg(r.key) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                      WHERE ur.user_id = sp.user_id) AS roles,
                    -- Surfaced so the compliance dashboard can chase a lapse
                    -- before it stops someone prescribing mid-clinic.
                    (sp.license_expires_on IS NOT NULL
                      AND sp.license_expires_on <= CURRENT_DATE + 60) AS licence_expiring_soon
               FROM staff_profiles sp
               LEFT JOIN departments d ON d.id = sp.primary_department_id
               LEFT JOIN facilities f ON f.id = sp.primary_facility_id
               LEFT JOIN users u ON u.id = sp.user_id
               ${whereClause}
              ORDER BY sp.family_name, sp.given_name
              LIMIT ${query.pageSize} OFFSET ${offset}`,
            params,
          ),
          db.query<{ count: string }>(`SELECT count(*) FROM staff_profiles sp ${whereClause}`, params),
        ]);

        return { items: rows, total: Number(countRows[0]?.count ?? 0) };
      });

      res.json({
        data: result.items,
        meta: { total: result.total, page: query.page, pageSize: query.pageSize },
      });
    } catch (error) {
      next(error);
    }
  },
);

/** Set a provider's weekly working pattern. */
staffRoutes.put(
  '/:staffProfileId/availability',
  requirePermission('schedule:manage'),
  validate({
    params: z.object({ staffProfileId: z.string().uuid() }),
    body: z.object({
      facilityId: z.string().uuid().optional(),
      rules: z
        .array(
          z.object({
            dayOfWeek: z.coerce.number().int().min(1).max(7),
            startTime: z.string().regex(/^\d{2}:\d{2}$/),
            endTime: z.string().regex(/^\d{2}:\d{2}$/),
            slotMinutes: z.coerce.number().int().min(5).max(240).default(20),
            capacity: z.coerce.number().int().min(1).max(20).default(1),
            availabilityKind: z
              .enum(['clinic', 'telehealth', 'surgery', 'on_call', 'admin'])
              .default('clinic'),
          }),
        )
        .max(21),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffProfileId = param(req, 'staffProfileId');
      const input = req.body as {
        facilityId?: string;
        rules: Array<{
          dayOfWeek: number;
          startTime: string;
          endTime: string;
          slotMinutes: number;
          capacity: number;
          availabilityKind: string;
        }>;
        effectiveFrom?: string;
      };

      const result = await runInTenant(req, async ({ db, tenantId }, collect) => {
        for (const rule of input.rules) {
          if (rule.endTime <= rule.startTime) {
            throw new AppError(
              422,
              'VALIDATION_FAILED',
              `Day ${rule.dayOfWeek}: the end time must be after the start time.`,
            );
          }
        }

        // Existing rules are closed off rather than deleted, so appointments
        // already booked under the old pattern remain explicable.
        await db.query(
          `UPDATE provider_availability
              SET effective_until = COALESCE($3::date, CURRENT_DATE) - 1
            WHERE staff_profile_id = $1
              AND ($2::uuid IS NULL OR facility_id = $2)
              AND (effective_until IS NULL OR effective_until >= CURRENT_DATE)`,
          [staffProfileId, input.facilityId ?? null, input.effectiveFrom ?? null],
        );

        let inserted = 0;
        for (const rule of input.rules) {
          await db.query(
            `INSERT INTO provider_availability (tenant_id, staff_profile_id, facility_id, day_of_week,
                                                start_time, end_time, slot_minutes, capacity,
                                                availability_kind, effective_from)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::date, CURRENT_DATE))`,
            [
              tenantId,
              staffProfileId,
              input.facilityId ?? null,
              rule.dayOfWeek,
              rule.startTime,
              rule.endTime,
              rule.slotMinutes,
              rule.capacity,
              rule.availabilityKind,
              input.effectiveFrom ?? null,
            ],
          );
          inserted += 1;
        }

        collect({
          action: 'schedule.set_availability',
          resourceType: 'staff_profile',
          resourceId: staffProfileId,
          metadata: { ruleCount: inserted, effectiveFrom: input.effectiveFrom ?? 'today' },
        });

        return { staffProfileId, rulesCreated: inserted };
      });

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  },
);

/** Record leave or another one-off change to a provider's diary. */
staffRoutes.post(
  '/:staffProfileId/time-off',
  requirePermission('schedule:manage'),
  validate({
    params: z.object({ staffProfileId: z.string().uuid() }),
    body: z.object({
      startsAt: z.string().datetime({ offset: true }),
      endsAt: z.string().datetime({ offset: true }),
      effect: z.enum(['unavailable', 'extra']).default('unavailable'),
      reason: z
        .enum(['leave', 'sick', 'training', 'conference', 'surgery', 'public_holiday', 'other'])
        .default('leave'),
      notes: z.string().max(500).optional(),
    }),
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const staffProfileId = param(req, 'staffProfileId');
      const input = req.body as {
        startsAt: string;
        endsAt: string;
        effect: string;
        reason: string;
        notes?: string;
      };

      const result = await runInTenant(req, async ({ db, tenantId }, collect) => {
        // Booked appointments inside the window are surfaced rather than
        // silently orphaned: somebody has to call those patients.
        const { rows: affected } = await db.query<{ count: string }>(
          `SELECT count(*) FROM appointments
            WHERE provider_id = $1
              AND status IN ('scheduled','confirmed','checked_in')
              AND slot && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
          [staffProfileId, input.startsAt, input.endsAt],
        );

        const { rows } = await db.query<{ id: string }>(
          `INSERT INTO availability_exceptions (tenant_id, staff_profile_id, starts_at, ends_at,
                                                effect, reason, notes, approved_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id`,
          [
            tenantId,
            staffProfileId,
            input.startsAt,
            input.endsAt,
            input.effect,
            input.reason,
            input.notes ?? null,
            req.principal!.userId,
          ],
        );

        collect({
          action: 'schedule.time_off',
          resourceType: 'availability_exception',
          resourceId: rows[0]!.id,
          metadata: {
            staffProfileId,
            reason: input.reason,
            appointmentsAffected: Number(affected[0]!.count),
          },
        });

        return {
          id: rows[0]!.id,
          appointmentsNeedingRebooking: Number(affected[0]!.count),
        };
      });

      res.status(201).json({
        data: result,
        meta:
          result.appointmentsNeedingRebooking > 0
            ? {
                warning: `${result.appointmentsNeedingRebooking} appointment(s) fall inside this period and need rebooking.`,
              }
            : undefined,
      });
    } catch (error) {
      next(error);
    }
  },
);
