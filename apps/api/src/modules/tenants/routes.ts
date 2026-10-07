/**
 * Tenant configuration: the hospital's own record, its sites and its
 * departments.
 *
 * Reads are open to any signed-in member of staff — the UI needs the
 * hospital's name, timezone and branding to render, and four screens need the
 * facility and department lists to draw a filter. Writes need
 * `tenant:settings`.
 *
 * NOTHING HERE DELETES. A facility is the foreign-key target of eleven tables,
 * among them appointments, encounters, invoices and stock locations; a
 * department of five more. Removing one would either cascade clinical history
 * away or quietly null out the site an encounter happened at, and "which
 * hospital was this consultation in" is not a question a record is allowed to
 * stop answering. So the lifecycle is `is_active`: a closed site stops being
 * offered for new work and keeps explaining the old.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { body, param, queryParams, validate } from '../../middleware/validate.js';
import { runInTenant, runInTenantReadOnly } from '../../middleware/tenant.js';
import { booleanish, ianaTimezone } from '../../utils/schema.js';
import type { Queryable } from '../../db/pool.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { subscriptionRoutes } from './subscription.js';

export const tenantRoutes = Router();
tenantRoutes.use(authenticate);

/*
 * What this hospital pays the vendor. Read-only, gated on tenant:settings,
 * and served over the ORDINARY tenant connection so row-level security does
 * the scoping — see ./subscription.ts.
 */
tenantRoutes.use('/subscription', subscriptionRoutes);

/* ---------------------------------------------------------------------------
 * Shared field shapes
 * ------------------------------------------------------------------------- */

/**
 * A short code, normalised to upper case before it is checked.
 *
 * Codes are woven into human-facing references and compared by equality, so
 * `main` and `MAIN` must not both exist. Upper-casing on the way in is what
 * makes the `UNIQUE (tenant_id, code)` index mean what a user assumes it means
 * — `citext` is used for emails and slugs in this schema, but these two
 * columns are plain `text`.
 */
const shortCode = () =>
  z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(
      z
        .string()
        .min(2)
        .max(16)
        .regex(
          /^[A-Z0-9][A-Z0-9-]*$/,
          'Use letters, digits and hyphens only, starting with a letter or digit.',
        ),
    );

/** An optional free-text field where "" from a cleared input means "unset". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullish();

const countryCode = () =>
  z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().length(2).regex(/^[A-Z]{2}$/, 'Use a two-letter ISO country code.'));

const FACILITY_KINDS = ['hospital', 'clinic', 'lab', 'pharmacy', 'imaging'] as const;

/* ---------------------------------------------------------------------------
 * Schemas
 * ------------------------------------------------------------------------- */

const updateSettingsSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  timezone: ianaTimezone().optional(),
  locale: z.string().max(16).optional(),
  currency: z.string().length(3).optional(),
  settings: z.record(z.unknown()).optional(),
  branding: z
    .object({
      primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      logoUrl: z.string().url().max(500).optional(),
      wordmark: z.string().max(60).optional(),
    })
    .optional(),
});

const listSchema = z.object({
  /** Administration needs the closed rows; pickers elsewhere must not see them. */
  includeInactive: booleanish().default(false),
});

const createFacilitySchema = z.object({
  name: z.string().trim().min(2).max(200),
  code: shortCode(),
  kind: z.enum(FACILITY_KINDS).default('clinic'),
  /** Absent means "follow the hospital", which is stored as NULL, not copied. */
  timezone: ianaTimezone().nullish(),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(120),
  region: optionalText(120),
  postalCode: optionalText(40),
  country: countryCode().optional(),
  phone: optionalText(40),
});

const updateFacilitySchema = createFacilitySchema.partial().extend({
  isActive: z.boolean().optional(),
});

const createDepartmentSchema = z.object({
  name: z.string().trim().min(2).max(200),
  code: shortCode(),
  /** Optional: a department may span the whole hospital rather than one site. */
  facilityId: z.string().uuid().nullish(),
  description: optionalText(500),
});

const updateDepartmentSchema = createDepartmentSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const facilityParams = z.object({ facilityId: z.string().uuid() });
const departmentParams = z.object({ departmentId: z.string().uuid() });

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

/**
 * Refuse a duplicate code with the message attached to the FIELD.
 *
 * The `UNIQUE (tenant_id, code)` index is the real guarantee and stays the
 * backstop for a race, but it surfaces as a bare "That record already exists."
 * Checking first lets the form mark up the code input, which is where the user
 * is looking.
 */
async function assertCodeFree(
  db: Queryable,
  table: 'facilities' | 'departments',
  tenantId: string,
  code: string,
  excludeId?: string,
): Promise<void> {
  const { rows } = await db.query<{ id: string; is_active: boolean; name: string }>(
    `SELECT id, is_active, name FROM ${table}
      WHERE tenant_id = $1 AND upper(code) = $2 AND ($3::uuid IS NULL OR id <> $3)
      LIMIT 1`,
    [tenantId, code, excludeId ?? null],
  );

  const clash = rows[0];
  if (!clash) return;

  // A clash with a CLOSED row is the confusing case, so it says so: the fix is
  // to reopen that one, not to invent a second code for the same place.
  throw new AppError(409, 'CONFLICT', 'That code is already in use.', {
    issues: [
      {
        field: 'code',
        message: clash.is_active
          ? `${clash.name} already uses the code ${code}.`
          : `${clash.name} used the code ${code} and is deactivated. Reactivate it instead of creating a second one.`,
      },
    ],
  });
}

/** Confirm a facility belongs to this tenant before a department points at it. */
async function assertFacilityExists(
  db: Queryable,
  tenantId: string,
  facilityId: string,
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM facilities WHERE tenant_id = $1 AND id = $2',
    [tenantId, facilityId],
  );

  if (rows.length === 0) {
    throw new AppError(422, 'VALIDATION_FAILED', 'That site could not be found.', {
      issues: [{ field: 'facilityId', message: 'Choose a site that still exists.' }],
    });
  }
}

/**
 * Build a partial UPDATE from the fields the caller actually sent.
 *
 * `undefined` means "not mentioned" and is skipped; `null` means "clear it"
 * and is written. Collapsing those two would make an untouched field
 * indistinguishable from a cleared one, so a form that edits the name would
 * erase the address.
 */
function assignments(
  mapping: Record<string, unknown>,
  params: unknown[],
): string[] {
  const clauses: string[] = [];

  for (const [column, value] of Object.entries(mapping)) {
    if (value === undefined) continue;
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  }

  return clauses;
}

const FACILITY_COLUMNS = `id, name, code, kind, address_line1, address_line2, city, region,
                          postal_code, country, phone, timezone, is_active, created_at`;

const DEPARTMENT_COLUMNS = `d.id, d.name, d.code, d.description, d.facility_id, d.is_active, d.created_at`;

/* ---------------------------------------------------------------------------
 * The hospital record
 * ------------------------------------------------------------------------- */

tenantRoutes.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await runInTenantReadOnly(req, async ({ db }) => {
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT t.id, t.slug, t.display_name, t.legal_name, t.facility_code,
                t.timezone, t.locale, t.currency, t.subscription_tier, t.settings, t.branding,
                (SELECT json_agg(json_build_object(
                   'id', f.id, 'name', f.name, 'code', f.code, 'kind', f.kind,
                   'timezone', COALESCE(f.timezone, t.timezone))
                 ORDER BY f.name)
                   FROM facilities f WHERE f.tenant_id = t.id AND f.is_active) AS facilities,
                (SELECT json_agg(json_build_object('id', d.id, 'name', d.name, 'code', d.code)
                 ORDER BY d.name)
                   FROM departments d WHERE d.tenant_id = t.id AND d.is_active) AS departments
           FROM tenants t
          WHERE t.id = $1`,
        [req.principal!.tenantId],
      );

      return rows[0] ?? null;
    });

    res.json({ data });
  } catch (error) {
    next(error);
  }
});

tenantRoutes.patch(
  '/',
  requirePermission('tenant:settings'),
  validate({ body: updateSettingsSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, updateSettingsSchema);

      const data = await runInTenant(req, async ({ db }, collect) => {
        const params: unknown[] = [req.principal!.tenantId];
        const clauses = assignments(
          {
            display_name: input.displayName,
            timezone: input.timezone,
            locale: input.locale,
            currency: input.currency,
          },
          params,
        );

        // jsonb columns are MERGED, not replaced, so a partial update cannot
        // wipe keys the caller did not send. The ::jsonb cast is required:
        // without it Postgres cannot resolve the || operator for a text param.
        const merge = (col: string, value: unknown) => {
          params.push(JSON.stringify(value));
          clauses.push(`${col} = ${col} || $${params.length}::jsonb`);
        };

        if (input.settings !== undefined) merge('settings', input.settings);
        if (input.branding !== undefined) merge('branding', input.branding);

        if (clauses.length === 0) return { updated: false };

        await db.query(`UPDATE tenants SET ${clauses.join(', ')} WHERE id = $1`, params);

        collect({
          action: 'tenant.settings_update',
          resourceType: 'tenant',
          resourceId: req.principal!.tenantId,
          metadata: { fields: Object.keys(input) },
        });

        return { updated: true };
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

/* ---------------------------------------------------------------------------
 * Facilities
 * ------------------------------------------------------------------------- */

/**
 * The administrative list: every column of the form, and the closed rows too.
 *
 * Separate from the `facilities` array on `GET /tenant` on purpose. That one
 * feeds the pickers on the booking, registration and stock screens, so it is
 * active-only and always will be; a settings screen that reused it could never
 * offer "reactivate".
 */
tenantRoutes.get(
  '/facilities',
  validate({ query: listSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { includeInactive } = queryParams(req, listSchema);

      const data = await runInTenantReadOnly(req, async ({ db, tenantId }) => {
        const { rows } = await db.query<Record<string, unknown>>(
          `SELECT ${FACILITY_COLUMNS},
                  (SELECT count(*) FROM departments d
                    WHERE d.facility_id = f.id AND d.is_active) AS active_department_count
             FROM facilities f
            WHERE f.tenant_id = $1 AND ($2 OR f.is_active)
            ORDER BY f.is_active DESC, f.name`,
          [tenantId, includeInactive],
        );

        return rows;
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

tenantRoutes.post(
  '/facilities',
  requirePermission('tenant:settings'),
  validate({ body: createFacilitySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, createFacilitySchema);

      const data = await runInTenant(req, async ({ db, tenantId }, collect) => {
        await assertCodeFree(db, 'facilities', tenantId, input.code);

        const { rows } = await db.query<Record<string, unknown>>(
          `INSERT INTO facilities (tenant_id, name, code, kind, address_line1, address_line2,
                                   city, region, postal_code, country, phone, timezone)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 'US'), $11, $12)
           RETURNING ${FACILITY_COLUMNS}`,
          [
            tenantId,
            input.name,
            input.code,
            input.kind,
            input.addressLine1 ?? null,
            input.addressLine2 ?? null,
            input.city ?? null,
            input.region ?? null,
            input.postalCode ?? null,
            input.country ?? null,
            input.phone ?? null,
            input.timezone ?? null,
          ],
        );

        const facility = rows[0]!;

        collect({
          action: 'facility.create',
          resourceType: 'facility',
          resourceId: facility.id as string,
          metadata: { code: input.code, kind: input.kind },
        });

        return facility;
      });

      res.status(201).json({ data });
    } catch (error) {
      next(error);
    }
  },
);

tenantRoutes.patch(
  '/facilities/:facilityId',
  requirePermission('tenant:settings'),
  validate({ params: facilityParams, body: updateFacilitySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const facilityId = param(req, 'facilityId');
      const input = body(req, updateFacilitySchema);

      const data = await runInTenant(req, async ({ db, tenantId }, collect) => {
        // Locked for the duration, so the last-active-site check below cannot
        // be raced by a second administrator closing the other one.
        const { rows: existing } = await db.query<{ id: string; is_active: boolean }>(
          'SELECT id, is_active FROM facilities WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
          [tenantId, facilityId],
        );

        const current = existing[0];
        if (!current) throw new NotFoundError('site');

        if (input.code !== undefined) {
          await assertCodeFree(db, 'facilities', tenantId, input.code, facilityId);
        }

        // A hospital with no open site cannot register a patient, book an
        // appointment or hold stock, so the last one does not close. Renaming
        // or reopening is always allowed.
        if (input.isActive === false && current.is_active) {
          const { rows: counts } = await db.query<{ remaining: string }>(
            `SELECT count(*) AS remaining FROM facilities
              WHERE tenant_id = $1 AND is_active AND id <> $2`,
            [tenantId, facilityId],
          );

          if (Number(counts[0]!.remaining) === 0) {
            throw new AppError(
              409,
              'PRECONDITION_FAILED',
              'This is the only open site. Registration, booking and stock all need one, so add another site before closing this one.',
            );
          }
        }

        const params: unknown[] = [tenantId, facilityId];
        const clauses = assignments(
          {
            name: input.name,
            code: input.code,
            kind: input.kind,
            address_line1: input.addressLine1,
            address_line2: input.addressLine2,
            city: input.city,
            region: input.region,
            postal_code: input.postalCode,
            country: input.country,
            phone: input.phone,
            timezone: input.timezone,
            is_active: input.isActive,
          },
          params,
        );

        if (clauses.length === 0) {
          const { rows } = await db.query<Record<string, unknown>>(
            `SELECT ${FACILITY_COLUMNS} FROM facilities WHERE tenant_id = $1 AND id = $2`,
            [tenantId, facilityId],
          );
          return rows[0]!;
        }

        const { rows } = await db.query<Record<string, unknown>>(
          `UPDATE facilities SET ${clauses.join(', ')}
            WHERE tenant_id = $1 AND id = $2
          RETURNING ${FACILITY_COLUMNS}`,
          params,
        );

        collect({
          action: input.isActive === false ? 'facility.deactivate' : 'facility.update',
          resourceType: 'facility',
          resourceId: facilityId,
          changes: { fields: Object.keys(input) },
        });

        return rows[0]!;
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

/* ---------------------------------------------------------------------------
 * Departments
 * ------------------------------------------------------------------------- */

tenantRoutes.get(
  '/departments',
  validate({ query: listSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { includeInactive } = queryParams(req, listSchema);

      const data = await runInTenantReadOnly(req, async ({ db, tenantId }) => {
        // The site's name is joined in because a code on its own does not tell
        // an administrator which Cardiology they are looking at.
        const { rows } = await db.query<Record<string, unknown>>(
          `SELECT ${DEPARTMENT_COLUMNS}, f.name AS facility_name, f.is_active AS facility_is_active,
                  (SELECT count(*) FROM staff_profiles s
                    WHERE s.primary_department_id = d.id) AS staff_count
             FROM departments d
             LEFT JOIN facilities f ON f.id = d.facility_id
            WHERE d.tenant_id = $1 AND ($2 OR d.is_active)
            ORDER BY d.is_active DESC, d.name`,
          [tenantId, includeInactive],
        );

        return rows;
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);

tenantRoutes.post(
  '/departments',
  requirePermission('tenant:settings'),
  validate({ body: createDepartmentSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = body(req, createDepartmentSchema);

      const data = await runInTenant(req, async ({ db, tenantId }, collect) => {
        await assertCodeFree(db, 'departments', tenantId, input.code);
        if (input.facilityId) await assertFacilityExists(db, tenantId, input.facilityId);

        const { rows } = await db.query<Record<string, unknown>>(
          `INSERT INTO departments (tenant_id, name, code, facility_id, description)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, code, description, facility_id, is_active, created_at`,
          [tenantId, input.name, input.code, input.facilityId ?? null, input.description ?? null],
        );

        const department = rows[0]!;

        collect({
          action: 'department.create',
          resourceType: 'department',
          resourceId: department.id as string,
          metadata: { code: input.code },
        });

        return department;
      });

      res.status(201).json({ data });
    } catch (error) {
      next(error);
    }
  },
);

tenantRoutes.patch(
  '/departments/:departmentId',
  requirePermission('tenant:settings'),
  validate({ params: departmentParams, body: updateDepartmentSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const departmentId = param(req, 'departmentId');
      const input = body(req, updateDepartmentSchema);

      const data = await runInTenant(req, async ({ db, tenantId }, collect) => {
        const { rows: existing } = await db.query<{ id: string }>(
          'SELECT id FROM departments WHERE tenant_id = $1 AND id = $2',
          [tenantId, departmentId],
        );

        if (existing.length === 0) throw new NotFoundError('department');

        if (input.code !== undefined) {
          await assertCodeFree(db, 'departments', tenantId, input.code, departmentId);
        }
        if (input.facilityId) await assertFacilityExists(db, tenantId, input.facilityId);

        const params: unknown[] = [tenantId, departmentId];
        const clauses = assignments(
          {
            name: input.name,
            code: input.code,
            facility_id: input.facilityId,
            description: input.description,
            is_active: input.isActive,
          },
          params,
        );

        if (clauses.length === 0) {
          const { rows } = await db.query<Record<string, unknown>>(
            `SELECT id, name, code, description, facility_id, is_active, created_at
               FROM departments WHERE tenant_id = $1 AND id = $2`,
            [tenantId, departmentId],
          );
          return rows[0]!;
        }

        const { rows } = await db.query<Record<string, unknown>>(
          `UPDATE departments SET ${clauses.join(', ')}
            WHERE tenant_id = $1 AND id = $2
          RETURNING id, name, code, description, facility_id, is_active, created_at`,
          params,
        );

        collect({
          action: input.isActive === false ? 'department.deactivate' : 'department.update',
          resourceType: 'department',
          resourceId: departmentId,
          changes: { fields: Object.keys(input) },
        });

        return rows[0]!;
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);
