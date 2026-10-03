import { z } from 'zod';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'That is not a real date.');

const addressSchema = z.object({
  line1: z.string().max(200).optional(),
  line2: z.string().max(200).optional(),
  city: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  postalCode: z.string().max(32).optional(),
  country: z.string().length(2).optional(),
});

const emergencyContactSchema = z.object({
  name: z.string().min(1).max(200),
  relationship: z.string().max(80).optional(),
  phone: z.string().min(5).max(40),
  altPhone: z.string().max(40).optional(),
});

/**
 * The field definitions, before any cross-field refinement.
 *
 * Kept separate because `.refine()` returns a ZodEffects, which has no
 * `.partial()` — so the PATCH schema has to be derived from the plain object.
 */
const patientFields = z.object({
  givenName: z.string().min(1, 'First name is required.').max(120),
  middleName: z.string().max(120).optional(),
  familyName: z.string().min(1, 'Family name is required.').max(120),
  preferredName: z.string().max(120).optional(),
  dateOfBirth: isoDate,
  sexAtBirth: z.enum(['female', 'male', 'intersex', 'unknown']),
  genderIdentity: z.string().max(80).optional(),
  pronouns: z.string().max(40).optional(),
  maritalStatus: z.enum(['single', 'married', 'partnered', 'divorced', 'widowed', 'unknown']).optional(),
  bloodType: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown']).optional(),
  preferredLanguage: z.string().max(16).default('en'),
  requiresInterpreter: z.boolean().default(false),
  nationality: z.string().length(2).optional(),

  // Direct identifiers. Encrypted before they reach the database.
  nationalId: z.string().max(64).optional(),
  phone: z.string().min(5, 'Enter a usable phone number.').max(40).optional(),
  altPhone: z.string().max(40).optional(),
  email: z.string().email('Enter a valid email address.').max(320).optional(),
  address: addressSchema.optional(),
  emergencyContact: emergencyContactSchema.optional(),

  primaryProviderId: z.string().uuid().optional(),
  registeredFacilityId: z.string().uuid().optional(),
  registrationSource: z
    .enum(['front_desk', 'portal', 'import', 'referral', 'emergency'])
    .default('front_desk'),

  /**
   * Set when the registrar has reviewed the duplicate candidates the API
   * returned and confirmed this is a genuinely different person.
   */
  acknowledgeDuplicates: z.boolean().default(false),
});

export const createPatientSchema = patientFields
  .refine((v) => v.dateOfBirth <= new Date().toISOString().slice(0, 10), {
    message: 'Date of birth cannot be in the future.',
    path: ['dateOfBirth'],
  })
  // One reachable contact method, or reminders and results have nowhere to go.
  .refine((v) => Boolean(v.phone || v.email), {
    message: 'Record at least a phone number or an email address.',
    path: ['phone'],
  });

/**
 * PATCH accepts any subset. The contact-method rule is deliberately NOT
 * re-applied: an update that touches only a patient's blood type should not be
 * rejected for omitting a phone number it is not changing.
 */
export const updatePatientSchema = patientFields
  .omit({ acknowledgeDuplicates: true, registrationSource: true })
  .partial();

export const searchPatientsSchema = z.object({
  /** Free text over name and MRN. */
  q: z.string().max(120).optional(),
  /** Exact-match lookups, resolved through blind indexes. */
  mrn: z.string().max(64).optional(),
  phone: z.string().max(40).optional(),
  nationalId: z.string().max(64).optional(),
  email: z.string().max(320).optional(),
  dateOfBirth: isoDate.optional(),
  status: z.enum(['active', 'inactive', 'deceased', 'merged', 'archived']).optional(),
  primaryProviderId: z.string().uuid().optional(),
  facilityId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['name', 'registered', 'last_seen']).default('name'),
});

export const patientIdParam = z.object({ patientId: z.string().uuid('Not a valid patient id.') });

export const allergySchema = z.object({
  allergen: z.string().min(1).max(200),
  allergenKind: z
    .enum(['medication', 'food', 'environmental', 'latex', 'contrast', 'other'])
    .default('medication'),
  medicationId: z.string().uuid().optional(),
  reaction: z.string().max(500).optional(),
  severity: z.enum(['mild', 'moderate', 'severe', 'anaphylaxis']).default('moderate'),
  onsetOn: isoDate.optional(),
});

export const breakGlassSchema = z.object({
  patientId: z.string().uuid(),
  justification: z
    .string()
    .min(20, 'Explain the clinical need in at least 20 characters. This is reviewed by the privacy officer.')
    .max(1000),
  /** Hours the grant stays valid. Short by design. */
  durationHours: z.coerce.number().int().min(1).max(24).default(8),
});

export type CreatePatientInput = z.infer<typeof createPatientSchema>;
export type UpdatePatientInput = z.infer<typeof updatePatientSchema>;
export type SearchPatientsInput = z.infer<typeof searchPatientsSchema>;
