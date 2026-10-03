import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.');
const isoDateTime = z.string().datetime({ offset: true, message: 'Use an ISO-8601 timestamp with an offset.' });

export const availabilitySchema = z
  .object({
    providerId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    facilityId: z.string().uuid().optional(),
    appointmentTypeId: z.string().uuid('Choose an appointment type.'),
    from: isoDate,
    to: isoDate,
    modality: z.enum(['in_person', 'telehealth', 'home_visit', 'phone']).optional(),
  })
  .refine((v) => v.to >= v.from, { message: '"to" must not be before "from".', path: ['to'] })
  // An unbounded window would scan every rule for every provider; 60 days is
  // well beyond any real booking horizon shown in one view.
  .refine(
    (v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 60,
    { message: 'Request at most 60 days at a time.', path: ['to'] },
  )
  .refine((v) => Boolean(v.providerId || v.departmentId), {
    message: 'Specify either a provider or a department.',
    path: ['providerId'],
  });

export const bookAppointmentSchema = z.object({
  patientId: z.string().uuid(),
  providerId: z.string().uuid(),
  appointmentTypeId: z.string().uuid(),
  facilityId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  startsAt: isoDateTime,
  /** Omitted means "use the appointment type's duration". */
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
  modality: z.enum(['in_person', 'telehealth', 'home_visit', 'phone']).default('in_person'),
  priority: z.enum(['routine', 'urgent', 'emergency', 'follow_up']).default('routine'),
  bookingChannel: z
    .enum(['front_desk', 'portal', 'phone', 'walk_in', 'referral', 'recall'])
    .default('front_desk'),
  reasonForVisit: z.string().max(500).optional(),
  /** Patient-authored detail; sensitive, so it is encrypted at rest. */
  patientNotes: z.string().max(2000).optional(),
  room: z.string().max(60).optional(),
  /** Overrides the tenant default reminder schedule. */
  reminderOffsetsHours: z.array(z.coerce.number().int().min(0).max(336)).max(5).optional(),
});

export const rescheduleSchema = z.object({
  startsAt: isoDateTime,
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
  providerId: z.string().uuid().optional(),
  reason: z.string().max(500).optional(),
});

export const cancelSchema = z.object({
  reason: z.string().min(1, 'Record why the appointment was cancelled.').max(500),
  /** Offer the freed slot to the waitlist. */
  releaseToWaitlist: z.boolean().default(true),
});

export const listAppointmentsSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  providerId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  facilityId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  status: z
    .union([
      z.enum(['scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show', 'rescheduled']),
      z.array(z.string()),
    ])
    .optional(),
  view: z.enum(['day', 'week', 'list']).default('list'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const appointmentIdParam = z.object({ appointmentId: z.string().uuid() });

export const checkInSchema = z.object({
  /** Blocking an arrival on an unpaid copay is a policy decision, not a default. */
  copayCollectedCents: z.coerce.number().int().min(0).optional(),
  notes: z.string().max(500).optional(),
});

export type AvailabilityQuery = z.infer<typeof availabilitySchema>;
export type BookAppointmentInput = z.infer<typeof bookAppointmentSchema>;
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsSchema>;
