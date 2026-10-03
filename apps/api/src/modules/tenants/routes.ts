/**
 * Tenant configuration.
 *
 * Reads are open to any signed-in member of staff — the UI needs the hospital's
 * name, timezone and branding to render. Writes need `tenant:settings`.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import { body, validate } from '../../middleware/validate.js';
import { runInTenant, runInTenantReadOnly } from '../../middleware/tenant.js';

export const tenantRoutes = Router();
tenantRoutes.use(authenticate);

const updateSettingsSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  timezone: z.string().max(64).optional(),
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
        const assignments: string[] = [];
        const params: unknown[] = [req.principal!.tenantId];

        const set = (col: string, value: unknown) => {
          params.push(value);
          assignments.push(`${col} = $${params.length}`);
        };

        // jsonb columns are MERGED, not replaced, so a partial update cannot
        // wipe keys the caller did not send. The ::jsonb cast is required:
        // without it Postgres cannot resolve the || operator for a text param.
        const merge = (col: string, value: unknown) => {
          params.push(JSON.stringify(value));
          assignments.push(`${col} = ${col} || $${params.length}::jsonb`);
        };

        if (input.displayName !== undefined) set('display_name', input.displayName);
        if (input.timezone !== undefined) set('timezone', input.timezone);
        if (input.locale !== undefined) set('locale', input.locale);
        if (input.currency !== undefined) set('currency', input.currency);
        if (input.settings !== undefined) merge('settings', input.settings);
        if (input.branding !== undefined) merge('branding', input.branding);

        if (assignments.length === 0) return { updated: false };

        await db.query(`UPDATE tenants SET ${assignments.join(', ')} WHERE id = $1`, params);

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
