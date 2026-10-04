/**
 * Appointment scheduling.
 *
 * TWO THINGS HERE ARE EASY TO GET WRONG
 * -------------------------------------
 * 1. TIMEZONES. Availability rules are stored as local wall-clock `time`
 *    values and converted with `AT TIME ZONE <facility tz>`. A clinic that
 *    starts at 09:00 must still start at 09:00 the day after a DST change; had
 *    the rules been stored as fixed offsets, every clinic in the country would
 *    silently shift by an hour twice a year.
 *
 * 2. CONCURRENCY. Two parents booking the last paediatric slot at the same
 *    moment will both pass any check-then-insert. The slot query below is a
 *    hint for the UI, not the decision: the decision is the database's
 *    `excl_provider_double_booking` exclusion constraint, and the loser of the
 *    race gets a 409 translated from SQLSTATE 23P01.
 */
import type { Request } from 'express';
import { AppError, NotFoundError, SlotUnavailableError } from '../../utils/errors.js';
import { createFieldCipher } from '../../security/crypto.js';
import { assertPatientAccess } from '../../security/rbac.js';
import { runInTenant, runInTenantReadOnly } from '../../middleware/tenant.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { Queryable } from '../../db/pool.js';
import type { AvailabilityQuery, BookAppointmentInput, ListAppointmentsQuery } from './schemas.js';

/* ---------------------------------------------------------------------------
 * Availability
 * ------------------------------------------------------------------------- */

export interface FreeSlot {
  providerId: string;
  providerName: string;
  facilityId: string | null;
  startsAt: string;
  endsAt: string;
  /** Wall-clock time at the facility, which is what the UI should display. */
  localTime: string;
  localDate: string;
  timezone: string;
  remainingCapacity: number;
  modality: string;
}

/**
 * The bookable appointment types.
 *
 * A booking cannot be made without one — the type carries the duration, the
 * buffer, the notice period and the modality — so a booking screen is unusable
 * without this list. `patient_bookable` is returned because the portal must
 * offer only what the hospital has opened to self-booking, and the service
 * enforces the same rule when the slot search runs.
 */
export async function listAppointmentTypes(req: Request): Promise<Array<Record<string, unknown>>> {
  return runInTenantReadOnly(req, async ({ db }) => {
    const portalUser = Boolean(req.principal?.patientId);

    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT at.id, at.code, at.name, at.duration_minutes, at.buffer_after_minutes,
              at.modality, at.colour, at.base_price_cents, at.min_notice_hours,
              at.max_advance_days, at.patient_bookable, at.requires_referral,
              at.department_id, d.name AS department_name
         FROM appointment_types at
         LEFT JOIN departments d ON d.id = at.department_id
        WHERE at.is_active
          AND ($1::boolean IS NOT TRUE OR at.patient_bookable)
        ORDER BY d.name NULLS FIRST, at.name`,
      [portalUser],
    );

    return rows;
  });
}

/**
 * Expand availability rules into bookable slots, minus leave, minus existing
 * bookings, minus anything inside the appointment type's notice period.
 *
 * Done in one query rather than in application code: expanding 60 days of
 * rules for a department of twenty clinicians is tens of thousands of
 * candidate slots, and shipping those to Node to filter them would be both
 * slower and a second place for the overlap logic to drift out of step with
 * the exclusion constraint.
 */
export async function findAvailableSlots(
  req: Request,
  input: AvailabilityQuery,
): Promise<FreeSlot[]> {
  return runInTenantReadOnly(req, async ({ db }) => {
    const { rows: typeRows } = await db.query<{
      duration_minutes: number;
      buffer_after_minutes: number;
      min_notice_hours: number;
      max_advance_days: number;
      modality: string;
      patient_bookable: boolean;
    }>(
      `SELECT duration_minutes, buffer_after_minutes, min_notice_hours,
              max_advance_days, modality, patient_bookable
         FROM appointment_types
        WHERE id = $1 AND is_active`,
      [input.appointmentTypeId],
    );

    const type = typeRows[0];
    if (!type) throw new NotFoundError('appointment type');

    // A portal user may only see slots the tenant has opened to self-booking.
    if (req.principal?.patientId && !type.patient_bookable) {
      throw new AppError(403, 'FORBIDDEN', 'This appointment type must be booked by the clinic.');
    }

    // The room-turnover buffer is part of what the provider's time costs, so it
    // is included when testing a candidate slot for overlap.
    const occupancyMinutes = type.duration_minutes + type.buffer_after_minutes;

    const { rows } = await db.query<{
      provider_id: string;
      provider_name: string;
      facility_id: string | null;
      starts_at: Date;
      ends_at: Date;
      tz: string;
      local_date: string;
      local_time: string;
      capacity: number;
      booked: number;
      availability_kind: string;
    }>(
      `
      WITH params AS (
        SELECT $1::uuid        AS provider_id,
               $2::uuid        AS department_id,
               $3::uuid        AS facility_id,
               $4::date        AS from_date,
               $5::date        AS to_date,
               $6::integer     AS duration_minutes,
               $7::integer     AS occupancy_minutes,
               $8::integer     AS min_notice_hours,
               $9::integer     AS max_advance_days
      ),
      -- Candidate providers: one named clinician, or everyone bookable in a
      -- department who is still actively taking patients.
      providers AS (
        SELECT sp.id, sp.display_name, sp.primary_facility_id
          FROM staff_profiles sp
          CROSS JOIN params p
         WHERE sp.is_provider
           AND sp.is_active
           AND (p.provider_id IS NULL OR sp.id = p.provider_id)
           AND (p.department_id IS NULL OR sp.primary_department_id = p.department_id)
           AND (sp.terminated_on IS NULL OR sp.terminated_on > CURRENT_DATE)
      ),
      rules AS (
        SELECT pa.id, pa.staff_profile_id, pa.facility_id, pa.day_of_week,
               pa.start_time, pa.end_time, pa.slot_minutes, pa.capacity,
               pa.availability_kind, pa.effective_from, pa.effective_until,
               -- Facility timezone wins; the tenant's is the fallback.
               COALESCE(f.timezone, t.timezone, 'UTC') AS tz
          FROM provider_availability pa
          CROSS JOIN params p
          JOIN providers pr ON pr.id = pa.staff_profile_id
          JOIN tenants t ON t.id = pa.tenant_id
          LEFT JOIN facilities f ON f.id = pa.facility_id
         WHERE (p.facility_id IS NULL OR pa.facility_id = p.facility_id OR pa.facility_id IS NULL)
      ),
      days AS (
        SELECT d::date AS day
          FROM params p,
               generate_series(p.from_date, p.to_date, interval '1 day') AS d
      ),
      slots AS (
        SELECT r.staff_profile_id AS provider_id,
               r.facility_id,
               r.capacity,
               r.tz,
               r.availability_kind,
               gs AS starts_at,
               gs + make_interval(mins => p.duration_minutes) AS ends_at,
               gs + make_interval(mins => p.occupancy_minutes) AS occupied_until
          FROM days
          CROSS JOIN params p
          JOIN rules r ON EXTRACT(ISODOW FROM days.day) = r.day_of_week
          -- The wall-clock-to-instant conversion that makes this DST-correct.
          CROSS JOIN LATERAL generate_series(
            ((days.day + r.start_time) AT TIME ZONE r.tz),
            ((days.day + r.end_time) AT TIME ZONE r.tz)
              - make_interval(mins => p.occupancy_minutes),
            make_interval(mins => r.slot_minutes)
          ) AS gs
         WHERE days.day >= r.effective_from
           AND (r.effective_until IS NULL OR days.day <= r.effective_until)
      )
      SELECT s.provider_id,
             pr.display_name AS provider_name,
             s.facility_id,
             s.starts_at,
             s.ends_at,
             s.tz,
             to_char(s.starts_at AT TIME ZONE s.tz, 'YYYY-MM-DD') AS local_date,
             to_char(s.starts_at AT TIME ZONE s.tz, 'HH24:MI')    AS local_time,
             s.capacity,
             s.availability_kind,
             (SELECT count(*)
                FROM appointments a
               WHERE a.provider_id = s.provider_id
                 AND a.status IN ('scheduled','confirmed','checked_in','in_progress')
                 AND a.slot && tstzrange(s.starts_at, s.occupied_until, '[)')
             )::int AS booked
        FROM slots s
        JOIN providers pr ON pr.id = s.provider_id
        CROSS JOIN params p
       WHERE s.starts_at >= now() + make_interval(hours => p.min_notice_hours)
         AND s.starts_at <= now() + make_interval(days => p.max_advance_days)
         -- Leave, training, theatre lists: anything marked unavailable.
         AND NOT EXISTS (
           SELECT 1 FROM availability_exceptions ex
            WHERE ex.staff_profile_id = s.provider_id
              AND ex.effect = 'unavailable'
              AND ex.period && tstzrange(s.starts_at, s.occupied_until, '[)')
         )
       ORDER BY s.starts_at, pr.display_name
       LIMIT 2000
      `,
      [
        input.providerId ?? null,
        input.departmentId ?? null,
        input.facilityId ?? null,
        input.from,
        input.to,
        type.duration_minutes,
        occupancyMinutes,
        type.min_notice_hours,
        type.max_advance_days,
      ],
    );

    return rows
      .filter((row) => row.booked < row.capacity)
      .map((row) => ({
        providerId: row.provider_id,
        providerName: row.provider_name,
        facilityId: row.facility_id,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
        localDate: row.local_date,
        localTime: row.local_time,
        timezone: row.tz,
        remainingCapacity: row.capacity - row.booked,
        modality: input.modality ?? type.modality,
      }));
  });
}

/* ---------------------------------------------------------------------------
 * Booking
 * ------------------------------------------------------------------------- */

export interface BookedAppointment {
  id: string;
  reference: string;
  patientId: string;
  providerId: string;
  providerName: string;
  startsAt: string;
  endsAt: string;
  status: string;
  modality: string;
  remindersScheduled: number;
}

/**
 * Book an appointment.
 *
 * Runs SERIALIZABLE so the reminder rows and the booking commit as one unit,
 * and relies on the exclusion constraint for the overlap decision rather than
 * a pre-flight check. `withTenant` retries once on a serialization failure.
 */
export async function bookAppointment(
  req: Request,
  input: BookAppointmentInput,
): Promise<BookedAppointment> {
  return runInTenant(
    req,
    async ({ db, tenantId }, collect) => {
      const principal = req.principal!;

      // A portal account may only book for itself.
      if (principal.patientId && principal.patientId !== input.patientId) {
        throw new AppError(403, 'FORBIDDEN', 'You can only book appointments for yourself.');
      }
      if (!principal.patientId) {
        await assertPatientAccess(db, principal, input.patientId);
      }

      const { rows: typeRows } = await db.query<{
        duration_minutes: number;
        buffer_after_minutes: number;
        min_notice_hours: number;
        max_advance_days: number;
        modality: string;
        patient_bookable: boolean;
        requires_referral: boolean;
        default_service_item_id: string | null;
      }>(
        `SELECT duration_minutes, buffer_after_minutes, min_notice_hours, max_advance_days,
                modality, patient_bookable, requires_referral, default_service_item_id
           FROM appointment_types WHERE id = $1 AND is_active`,
        [input.appointmentTypeId],
      );

      const type = typeRows[0];
      if (!type) throw new NotFoundError('appointment type');

      if (principal.patientId && !type.patient_bookable) {
        throw new AppError(403, 'FORBIDDEN', 'This appointment type must be booked by the clinic.');
      }

      const durationMinutes = input.durationMinutes ?? type.duration_minutes;
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

      if (startsAt.getTime() < Date.now()) {
        throw new AppError(422, 'VALIDATION_FAILED', 'That appointment time is in the past.');
      }

      // Self-service bookings respect the notice window; staff can override it,
      // because a clinician fitting in an urgent review should not be blocked
      // by a rule written for the patient portal.
      if (principal.patientId) {
        const noticeMs = type.min_notice_hours * 3_600_000;
        if (startsAt.getTime() - Date.now() < noticeMs) {
          throw new AppError(
            422,
            'VALIDATION_FAILED',
            `This appointment type must be booked at least ${type.min_notice_hours} hours ahead. Call the clinic for anything sooner.`,
          );
        }
      }

      // Leave is checked explicitly: the exclusion constraint covers overlapping
      // bookings, not the provider being on annual leave.
      const { rows: conflicts } = await db.query<{ reason: string }>(
        `SELECT reason FROM availability_exceptions
          WHERE staff_profile_id = $1
            AND effect = 'unavailable'
            AND period && tstzrange($2::timestamptz, $3::timestamptz, '[)')
          LIMIT 1`,
        [input.providerId, startsAt.toISOString(), endsAt.toISOString()],
      );

      if (conflicts.length > 0) {
        throw new AppError(
          409,
          'SLOT_UNAVAILABLE',
          'That clinician is not available then. Please choose another slot.',
          { logContext: { reason: conflicts[0]!.reason } },
        );
      }

      const wrapped = await loadTenantKey(db, tenantId);
      const cipher = createFieldCipher(tenantId, wrapped);

      const { rows: idRows } = await db.query<{ id: string; reference: string }>(
        `SELECT gen_random_uuid() AS id,
                hims_util.allocate_reference($1, 'appointment', 'APT') AS reference`,
        [tenantId],
      );
      const { id, reference } = idRows[0]!;

      let created;
      try {
        const { rows } = await db.query<{
          id: string;
          reference: string;
          starts_at: Date;
          ends_at: Date;
          status: string;
          modality: string;
        }>(
          `
          INSERT INTO appointments (
            id, tenant_id, reference, patient_id, provider_id, appointment_type_id,
            facility_id, department_id, room, starts_at, ends_at,
            modality, priority, booking_channel, reason_for_visit,
            patient_notes_encrypted, booked_by
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            $12, $13, $14, $15,
            $16, $17
          )
          RETURNING id, reference, starts_at, ends_at, status, modality
          `,
          [
            id,
            tenantId,
            reference,
            input.patientId,
            input.providerId,
            input.appointmentTypeId,
            input.facilityId ?? null,
            input.departmentId ?? null,
            input.room ?? null,
            startsAt.toISOString(),
            endsAt.toISOString(),
            input.modality,
            input.priority,
            input.bookingChannel,
            input.reasonForVisit ?? null,
            cipher.encrypt(input.patientNotes, {
              table: 'appointments',
              column: 'patient_notes_encrypted',
              recordId: id,
            }),
            principal.userId,
          ],
        );
        created = rows[0]!;
      } catch (error) {
        // The exclusion constraint is the authority on overlap. Translate it
        // into language the person at the desk can act on.
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as { constraint?: string }).constraint === 'excl_provider_double_booking'
        ) {
          throw new SlotUnavailableError();
        }
        throw error;
      }

      const remindersScheduled = await scheduleReminders(db, {
        tenantId,
        appointmentId: created.id,
        startsAt,
        offsets: input.reminderOffsetsHours ?? env.REMINDER_OFFSETS_HOURS,
        patientId: input.patientId,
      });

      const { rows: providerRows } = await db.query<{ display_name: string }>(
        'SELECT display_name FROM staff_profiles WHERE id = $1',
        [input.providerId],
      );

      collect({
        action: 'appointment.book',
        resourceType: 'appointment',
        resourceId: created.id,
        patientId: input.patientId,
        touchedPhi: true,
        metadata: {
          reference: created.reference,
          channel: input.bookingChannel,
          priority: input.priority,
          remindersScheduled,
        },
      });

      return {
        id: created.id,
        reference: created.reference,
        patientId: input.patientId,
        providerId: input.providerId,
        providerName: providerRows[0]?.display_name ?? '',
        startsAt: created.starts_at.toISOString(),
        endsAt: created.ends_at.toISOString(),
        status: created.status,
        modality: created.modality,
        remindersScheduled,
      };
    },
    { isolation: 'serializable' },
  );
}

/**
 * Plan reminder sends, honouring the recipient's channel preferences.
 *
 * Written in the SAME transaction as the booking: an appointment nobody will
 * be reminded about is a no-show waiting to happen, and a reminder for an
 * appointment that failed to save is worse. Offsets already in the past are
 * skipped rather than fired immediately.
 */
async function scheduleReminders(
  db: Queryable,
  opts: {
    tenantId: string;
    appointmentId: string;
    startsAt: Date;
    offsets: number[];
    patientId: string;
  },
): Promise<number> {
  // Default both channels on; a row in notification_preferences can turn
  // either off, and TCPA makes honouring that non-optional for SMS.
  const { rows: prefs } = await db.query<{ channel: string; enabled: boolean }>(
    `SELECT channel, enabled
       FROM notification_preferences
      WHERE patient_id = $1 AND category = 'appointment'`,
    [opts.patientId],
  );

  const disabled = new Set(prefs.filter((p) => !p.enabled).map((p) => p.channel));
  const channels = (['email', 'sms'] as const).filter((c) => !disabled.has(c));

  let scheduled = 0;

  for (const offsetHours of opts.offsets) {
    const sendAt = new Date(opts.startsAt.getTime() - offsetHours * 3_600_000);
    if (sendAt.getTime() <= Date.now()) continue;

    for (const channel of channels) {
      const { rowCount } = await db.query(
        `INSERT INTO appointment_reminders (tenant_id, appointment_id, channel, offset_hours, scheduled_for)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (appointment_id, channel, offset_hours) DO NOTHING`,
        [opts.tenantId, opts.appointmentId, channel, offsetHours, sendAt.toISOString()],
      );
      scheduled += rowCount ?? 0;
    }
  }

  return scheduled;
}

/* ---------------------------------------------------------------------------
 * Reschedule and cancel
 * ------------------------------------------------------------------------- */

/**
 * Move an appointment.
 *
 * The original row is kept and marked `rescheduled`, pointing at its
 * replacement. Mutating the timestamps in place would erase the fact that the
 * patient was first offered an earlier date, which matters for access-target
 * reporting and for any later complaint.
 */
export async function rescheduleAppointment(
  req: Request,
  appointmentId: string,
  input: { startsAt: string; durationMinutes?: number; providerId?: string; reason?: string },
): Promise<BookedAppointment> {
  return runInTenant(
    req,
    async ({ db, tenantId }, collect) => {
      const principal = req.principal!;

      const { rows: existingRows } = await db.query<{
        id: string;
        patient_id: string;
        provider_id: string;
        appointment_type_id: string;
        facility_id: string | null;
        department_id: string | null;
        room: string | null;
        modality: string;
        priority: string;
        reason_for_visit: string | null;
        status: string;
        starts_at: Date;
        ends_at: Date;
      }>('SELECT * FROM appointments WHERE id = $1', [appointmentId]);

      const existing = existingRows[0];
      if (!existing) throw new NotFoundError('appointment');

      if (['completed', 'cancelled', 'no_show', 'rescheduled'].includes(existing.status)) {
        throw new AppError(
          409,
          'PRECONDITION_FAILED',
          `This appointment is already ${existing.status.replace('_', ' ')} and cannot be moved.`,
        );
      }

      if (principal.patientId && principal.patientId !== existing.patient_id) {
        throw new AppError(403, 'FORBIDDEN', 'You can only change your own appointments.');
      }
      if (!principal.patientId) {
        await assertPatientAccess(db, principal, existing.patient_id);
      }

      const durationMs =
        (input.durationMinutes ?? (existing.ends_at.getTime() - existing.starts_at.getTime()) / 60_000) *
        60_000;
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(startsAt.getTime() + durationMs);
      const providerId = input.providerId ?? existing.provider_id;

      // Release the old slot first, inside this transaction, so moving an
      // appointment forward by fifteen minutes does not collide with itself.
      await db.query(
        `UPDATE appointments
            SET status = 'rescheduled', cancellation_reason = $2, cancelled_by = $3, cancelled_at = now()
          WHERE id = $1`,
        [appointmentId, input.reason ?? 'rescheduled', principal.userId],
      );

      // Pending reminders for the old time would otherwise still fire.
      await db.query(
        `UPDATE appointment_reminders SET status = 'cancelled'
          WHERE appointment_id = $1 AND status = 'pending'`,
        [appointmentId],
      );

      const { rows: idRows } = await db.query<{ id: string; reference: string }>(
        `SELECT gen_random_uuid() AS id,
                hims_util.allocate_reference($1, 'appointment', 'APT') AS reference`,
        [tenantId],
      );
      const { id: newId, reference } = idRows[0]!;

      let created;
      try {
        const { rows } = await db.query<{
          id: string;
          reference: string;
          starts_at: Date;
          ends_at: Date;
          status: string;
          modality: string;
        }>(
          `INSERT INTO appointments (
             id, tenant_id, reference, patient_id, provider_id, appointment_type_id,
             facility_id, department_id, room, starts_at, ends_at,
             modality, priority, booking_channel, reason_for_visit, booked_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'front_desk',$14,$15)
           RETURNING id, reference, starts_at, ends_at, status, modality`,
          [
            newId,
            tenantId,
            reference,
            existing.patient_id,
            providerId,
            existing.appointment_type_id,
            existing.facility_id,
            existing.department_id,
            existing.room,
            startsAt.toISOString(),
            endsAt.toISOString(),
            existing.modality,
            existing.priority,
            existing.reason_for_visit,
            principal.userId,
          ],
        );
        created = rows[0]!;
      } catch (error) {
        if ((error as { constraint?: string }).constraint === 'excl_provider_double_booking') {
          throw new SlotUnavailableError();
        }
        throw error;
      }

      await db.query('UPDATE appointments SET rescheduled_to_id = $2 WHERE id = $1', [
        appointmentId,
        newId,
      ]);

      const remindersScheduled = await scheduleReminders(db, {
        tenantId,
        appointmentId: newId,
        startsAt,
        offsets: env.REMINDER_OFFSETS_HOURS,
        patientId: existing.patient_id,
      });

      collect({
        action: 'appointment.reschedule',
        resourceType: 'appointment',
        resourceId: newId,
        patientId: existing.patient_id,
        touchedPhi: true,
        metadata: {
          from: existing.starts_at.toISOString(),
          to: startsAt.toISOString(),
          previousAppointmentId: appointmentId,
          reason: input.reason ?? null,
        },
      });

      const { rows: providerRows } = await db.query<{ display_name: string }>(
        'SELECT display_name FROM staff_profiles WHERE id = $1',
        [providerId],
      );

      return {
        id: created.id,
        reference: created.reference,
        patientId: existing.patient_id,
        providerId,
        providerName: providerRows[0]?.display_name ?? '',
        startsAt: created.starts_at.toISOString(),
        endsAt: created.ends_at.toISOString(),
        status: created.status,
        modality: created.modality,
        remindersScheduled,
      };
    },
    { isolation: 'serializable' },
  );
}

export async function cancelAppointment(
  req: Request,
  appointmentId: string,
  input: { reason: string; releaseToWaitlist: boolean },
): Promise<{ id: string; status: string; waitlistOffers: number }> {
  return runInTenant(req, async ({ db, tenantId }, collect) => {
    const principal = req.principal!;

    const { rows } = await db.query<{
      patient_id: string;
      status: string;
      starts_at: Date;
      appointment_type_id: string;
      provider_id: string;
      facility_id: string | null;
    }>(
      `SELECT patient_id, status, starts_at, appointment_type_id, provider_id, facility_id
         FROM appointments WHERE id = $1`,
      [appointmentId],
    );

    const appointment = rows[0];
    if (!appointment) throw new NotFoundError('appointment');

    if (['completed', 'cancelled', 'rescheduled'].includes(appointment.status)) {
      throw new AppError(409, 'PRECONDITION_FAILED', 'This appointment is already closed.');
    }

    if (principal.patientId && principal.patientId !== appointment.patient_id) {
      throw new AppError(403, 'FORBIDDEN', 'You can only cancel your own appointments.');
    }

    await db.query(
      `UPDATE appointments
          SET status = 'cancelled', cancelled_at = now(),
              cancellation_reason = $2, cancelled_by = $3
        WHERE id = $1`,
      [appointmentId, input.reason, principal.userId],
    );

    await db.query(
      `UPDATE appointment_reminders SET status = 'cancelled'
        WHERE appointment_id = $1 AND status = 'pending'`,
      [appointmentId],
    );

    // A freed slot is clinic capacity. Offer it to whoever has been waiting
    // longest at the highest priority, rather than letting it go unused.
    let waitlistOffers = 0;
    if (input.releaseToWaitlist && appointment.starts_at.getTime() > Date.now()) {
      const { rows: offers } = await db.query<{ id: string; patient_id: string }>(
        `UPDATE appointment_waitlist w
            SET status = 'offered',
                offered_at = now(),
                offer_expires_at = now() + interval '4 hours'
          WHERE w.id IN (
            SELECT id FROM appointment_waitlist
             WHERE status = 'waiting'
               AND appointment_type_id = $1
               AND (preferred_provider_id IS NULL OR preferred_provider_id = $2)
               AND earliest_date <= $3::date
               AND (latest_date IS NULL OR latest_date >= $3::date)
             ORDER BY priority, created_at
             LIMIT 3
          )
          RETURNING id, patient_id`,
        [appointment.appointment_type_id, appointment.provider_id, appointment.starts_at.toISOString()],
      );

      for (const offer of offers) {
        await db.query(
          `INSERT INTO notifications (tenant_id, patient_id, channel, template_key, category,
                                      priority, payload, dedupe_key)
           VALUES ($1, $2, 'sms', 'waitlist_slot_offer', 'appointment', 2, $3, $4)
           ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL
         DO NOTHING`,
          [
            tenantId,
            offer.patient_id,
            JSON.stringify({ slotAt: appointment.starts_at.toISOString() }),
            `waitlist:${offer.id}:${appointmentId}`,
          ],
        );
      }

      waitlistOffers = offers.length;
    }

    collect({
      action: 'appointment.cancel',
      resourceType: 'appointment',
      resourceId: appointmentId,
      patientId: appointment.patient_id,
      touchedPhi: true,
      metadata: {
        reason: input.reason,
        cancelledByPatient: Boolean(principal.patientId),
        hoursNotice: Math.round((appointment.starts_at.getTime() - Date.now()) / 3_600_000),
        waitlistOffers,
      },
    });

    if (waitlistOffers > 0) {
      logger.info({ appointmentId, waitlistOffers }, 'freed slot offered to the waitlist');
    }

    return { id: appointmentId, status: 'cancelled', waitlistOffers };
  });
}

/* ---------------------------------------------------------------------------
 * Front desk
 * ------------------------------------------------------------------------- */

export async function checkIn(
  req: Request,
  appointmentId: string,
  input: { copayCollectedCents?: number; notes?: string },
): Promise<{ id: string; status: string; checkedInAt: string; waitMinutes: number }> {
  return runInTenant(req, async ({ db }, collect) => {
    const principal = req.principal!;

    const { rows } = await db.query<{
      patient_id: string;
      status: string;
      starts_at: Date;
      checked_in_at: Date | null;
    }>('SELECT patient_id, status, starts_at, checked_in_at FROM appointments WHERE id = $1', [
      appointmentId,
    ]);

    const appointment = rows[0];
    if (!appointment) throw new NotFoundError('appointment');

    if (appointment.checked_in_at) {
      throw new AppError(409, 'PRECONDITION_FAILED', 'This patient is already checked in.');
    }
    if (!['scheduled', 'confirmed'].includes(appointment.status)) {
      throw new AppError(
        409,
        'PRECONDITION_FAILED',
        `Cannot check in an appointment that is ${appointment.status.replace('_', ' ')}.`,
      );
    }

    const { rows: updated } = await db.query<{ checked_in_at: Date }>(
      `UPDATE appointments
          SET status = 'checked_in', checked_in_at = now()
        WHERE id = $1
        RETURNING checked_in_at`,
      [appointmentId],
    );

    const checkedInAt = updated[0]!.checked_in_at;
    // Negative when the patient arrives early, which is the common case and
    // worth keeping as a signed number for the punctuality report.
    const waitMinutes = Math.round((checkedInAt.getTime() - appointment.starts_at.getTime()) / 60_000);

    collect({
      action: 'appointment.checkin',
      resourceType: 'appointment',
      resourceId: appointmentId,
      patientId: appointment.patient_id,
      touchedPhi: true,
      metadata: {
        waitMinutes,
        copayCollectedCents: input.copayCollectedCents ?? null,
        by: principal.userId,
      },
    });

    return {
      id: appointmentId,
      status: 'checked_in',
      checkedInAt: checkedInAt.toISOString(),
      waitMinutes,
    };
  });
}

/* ---------------------------------------------------------------------------
 * Reads
 * ------------------------------------------------------------------------- */

export interface AppointmentListItem {
  id: string;
  reference: string;
  patientId: string;
  patientName: string;
  patientMrn: string;
  providerId: string;
  providerName: string;
  appointmentType: string;
  typeColour: string;
  startsAt: string;
  endsAt: string;
  status: string;
  modality: string;
  priority: string;
  room: string | null;
  reasonForVisit: string | null;
  checkedInAt: string | null;
}

export async function listAppointments(
  req: Request,
  input: ListAppointmentsQuery,
): Promise<{ items: AppointmentListItem[]; total: number }> {
  return runInTenantReadOnly(req, async ({ db }, collect) => {
    const principal = req.principal!;
    const conditions: string[] = [];
    const params: unknown[] = [];

    const where = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace('$?', `$${params.length}`));
    };

    // A portal account sees only its own diary, whatever it asks for.
    if (principal.patientId) {
      where('a.patient_id = $?', principal.patientId);
    } else if (input.patientId) {
      where('a.patient_id = $?', input.patientId);
    }

    if (input.providerId) where('a.provider_id = $?', input.providerId);
    if (input.facilityId) where('a.facility_id = $?', input.facilityId);
    if (input.departmentId) where('a.department_id = $?', input.departmentId);
    if (input.from) where('a.starts_at >= $?::date', input.from);
    if (input.to) where("a.starts_at < ($?::date + interval '1 day')", input.to);

    if (input.status) {
      const statuses = Array.isArray(input.status) ? input.status : [input.status];
      where('a.status = ANY($?)', statuses);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (input.page - 1) * input.pageSize;

    const { rows: countRows } = await db.query<{ count: string }>(
      `SELECT count(*) FROM appointments a ${whereClause}`,
      params,
    );

    const { rows } = await db.query<{
      id: string;
      reference: string;
      patient_id: string;
      patient_name: string;
      patient_mrn: string;
      provider_id: string;
      provider_name: string;
      type_name: string;
      type_colour: string;
      starts_at: Date;
      ends_at: Date;
      status: string;
      modality: string;
      priority: string;
      room: string | null;
      reason_for_visit: string | null;
      checked_in_at: Date | null;
    }>(
      `
      SELECT a.id, a.reference, a.patient_id,
             p.full_name AS patient_name, p.mrn AS patient_mrn,
             a.provider_id, sp.display_name AS provider_name,
             at.name AS type_name, at.colour AS type_colour,
             a.starts_at, a.ends_at, a.status, a.modality, a.priority, a.room,
             a.reason_for_visit, a.checked_in_at
        FROM appointments a
        JOIN patients p ON p.id = a.patient_id
        JOIN staff_profiles sp ON sp.id = a.provider_id
        JOIN appointment_types at ON at.id = a.appointment_type_id
        ${whereClause}
       ORDER BY a.starts_at
       LIMIT ${input.pageSize} OFFSET ${offset}
      `,
      params,
    );

    collect({
      action: 'appointment.list',
      resourceType: 'appointment',
      touchedPhi: true,
      metadata: { resultCount: rows.length, view: input.view },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        reference: row.reference,
        patientId: row.patient_id,
        patientName: row.patient_name,
        patientMrn: row.patient_mrn,
        providerId: row.provider_id,
        providerName: row.provider_name,
        appointmentType: row.type_name,
        typeColour: row.type_colour,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
        status: row.status,
        modality: row.modality,
        priority: row.priority,
        room: row.room,
        reasonForVisit: row.reason_for_visit,
        checkedInAt: row.checked_in_at ? row.checked_in_at.toISOString() : null,
      })),
      total: Number(countRows[0]?.count ?? 0),
    };
  });
}

async function loadTenantKey(db: Queryable, tenantId: string): Promise<Buffer> {
  const { rows } = await db.query<{ dek_wrapped: Buffer }>(
    'SELECT dek_wrapped FROM tenants WHERE id = $1',
    [tenantId],
  );

  const wrapped = rows[0]?.dek_wrapped;
  if (!wrapped) throw new Error(`tenant ${tenantId} has no data encryption key`);
  return wrapped;
}
