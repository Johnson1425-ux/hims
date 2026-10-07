import { z } from 'zod';
import { booleanish, ianaTimezone } from '../../utils/schema.js';

export const platformLoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(16).max(200),
  password: z.string().min(1).max(200),
});

export const listTenantsSchema = z.object({
  q: z.string().max(120).optional(),
  status: z.enum(['provisioning', 'active', 'suspended', 'archived']).optional(),
  tier: z.enum(['trial', 'standard', 'enterprise']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Provisioning a hospital.
 *
 * The first administrator is NOT optional, and that is a deliberate
 * constraint rather than an oversight in the form. A tenant with no
 * administrator is a tenant nobody can get into, which turns every later
 * request for access into a support ticket that can only be answered by a
 * vendor operator reaching into the hospital's data — exactly the thing this
 * console exists to keep rare and auditable.
 */
export const provisionTenantSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Lower case letters, digits and hyphens only.'),
  legalName: z.string().trim().min(2).max(200),
  displayName: z.string().trim().min(2).max(200),
  facilityCode: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{2,8}$/, 'Two to eight letters or digits.')),
  timezone: ianaTimezone(),
  locale: z.string().trim().min(2).max(16).default('en-US'),
  currency: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/, 'A three-letter ISO currency code.')),
  subscriptionTier: z.enum(['trial', 'standard', 'enterprise']).default('trial'),

  // The first site. A hospital cannot register a patient without one, so it
  // is created here rather than left as a first-run chore.
  facilityName: z.string().trim().min(2).max(200),
  facilityKind: z.enum(['hospital', 'clinic', 'lab', 'pharmacy', 'imaging']).default('hospital'),
  city: z.string().trim().max(120).optional(),
  country: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'A two-letter ISO country code.')),

  adminEmail: z.string().email().max(320),
  adminFullName: z.string().trim().min(2).max(200),
  adminGivenName: z.string().trim().min(1).max(120),
  adminFamilyName: z.string().trim().min(1).max(120),
});

export const tenantStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'archived']),
  /**
   * Required when taking a hospital offline. "Why can we not sign in?" is the
   * first question support will be asked, and an unexplained status change
   * makes it unanswerable.
   */
  reason: z.string().trim().max(500).optional(),
});

export const tenantTierSchema = z.object({
  subscriptionTier: z.enum(['trial', 'standard', 'enterprise']),
  reason: z.string().trim().max(500).optional(),
});

export const inviteOperatorSchema = z.object({
  email: z.string().email().max(320),
  fullName: z.string().trim().min(2).max(200),
  isOwner: z.boolean().default(false),
});

export const operatorStatusSchema = z.object({
  status: z.enum(['active', 'suspended']),
});

export const auditQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  /** Vendor actions only. The default, since that is what this console is for. */
  platformOnly: booleanish().default(true),
  action: z.string().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const breakGlassQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  unreviewedOnly: booleanish().default(true),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/* ---------------------------------------------------------------------------
 * Subscription billing
 * ------------------------------------------------------------------------- */

const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

/** Money on the wire is always an integer of the smallest unit. */
const money = () => z.coerce.number().int().min(0).max(1_000_000_000_000);

export const updatePlanSchema = z.object({
  amountCents: money(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  description: z.string().trim().max(500).nullish(),
  isActive: z.boolean().optional(),
});

export const setSubscriptionSchema = z.object({
  currency: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/, 'A three-letter ISO currency code.'))
    .optional(),
  billingInterval: z.enum(['month', 'year']).optional(),
  /**
   * `null` is meaningful and distinct from omitting the field: it CLEARS a
   * negotiated rate and returns the hospital to the published price.
   */
  amountCents: money().nullable().optional(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
  trialEndsOn: isoDate().nullable().optional(),
  status: z.enum(['trialing', 'active', 'cancelled']).optional(),
  notes: z.string().trim().max(1000).nullish(),
});

export const listInvoicesSchema = z.object({
  tenantId: z.string().uuid().optional(),
  status: z.enum(['issued', 'partially_paid', 'paid', 'void']).optional(),
  overdueOnly: booleanish().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const recordPaymentSchema = z.object({
  amountCents: z.coerce.number().int().positive().max(1_000_000_000_000),
  receivedOn: isoDate().optional(),
  method: z
    .enum(['bank_transfer', 'mobile_money', 'card', 'cash', 'cheque', 'other'])
    .default('bank_transfer'),
  /** The transfer reference or mobile-money code reconciliation is done on. */
  reference: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(500).nullish(),
});

export const voidSchema = z.object({
  reason: z.string().trim().min(3, 'Say why.').max(500),
});
