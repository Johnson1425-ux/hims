'use client';

/**
 * Book an appointment.
 *
 * The slot list is the whole screen. Availability is computed server-side from
 * the provider's rota, their time off, the appointment type's duration and
 * buffer, the notice period and what is already booked — so the browser never
 * reasons about whether a time is free, it picks from times that are.
 *
 * Slots are shown in the FACILITY's timezone, which the server returns with
 * each one. A clinic in Dar es Salaam booked by someone whose laptop is on
 * another clock is not a hypothetical in a system that stores every time as an
 * absolute instant.
 *
 * Double-booking is refused by a database exclusion constraint, not by this
 * screen. If a colleague takes the slot between the search and the submit, the
 * API returns 409 and the message says so — the race is handled, not avoided.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/shell';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Skeleton } from '@/components/ui/primitives';
import { Field, Select, TextArea, useFormErrors } from '@/components/ui/forms';
import { PatientPicker } from '@/components/ui/patient-picker';
import { useSession } from '@/lib/session';
import { useTenant } from '@/lib/tenant';
import {
  ApiError,
  api,
  type AppointmentType,
  type FreeSlot,
  type PatientSummary,
  type StaffMember,
} from '@/lib/api';
import { formatDate, formatMoney, humanise, pluralise } from '@/lib/format';
import { IconCalendar } from '@/components/layout/icons';

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export default function BookAppointmentPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useSession();
  const { tenant } = useTenant();
  const { errors, message, setMessage, reset, capture } = useFormErrors();

  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [types, setTypes] = useState<AppointmentType[]>([]);
  const [providers, setProviders] = useState<StaffMember[]>([]);

  const [typeId, setTypeId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [from, setFrom] = useState(isoDay(0));
  const [to, setTo] = useState(isoDay(13));
  const [priority, setPriority] = useState('routine');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');

  const [slotsByDate, setSlotsByDate] = useState<Record<string, FreeSlot[]>>({});
  const [chosen, setChosen] = useState<FreeSlot | null>(null);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [booking, setBooking] = useState(false);

  // Arriving from a patient's chart pre-selects them, so the common path is
  // "this person, now" rather than searching for someone already on screen.
  useEffect(() => {
    const preset = params.get('patientId');
    if (!preset) return;

    void api
      .get<PatientSummary>(`/patients/${preset}`)
      .then(({ data }) => setPatient(data))
      .catch(() => undefined);
  }, [params]);

  useEffect(() => {
    const controller = new AbortController();

    void Promise.all([
      api.get<AppointmentType[]>('/appointments/types', undefined, controller.signal),
      api.get<StaffMember[]>('/staff', { providersOnly: 'true', pageSize: 100 }, controller.signal),
    ])
      .then(([typeResult, staffResult]) => {
        setTypes(typeResult.data);
        setProviders(staffResult.data);
        if (typeResult.data.length > 0) setTypeId((current) => current || typeResult.data[0]!.id);
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, []);

  const type = useMemo(() => types.find((t) => t.id === typeId) ?? null, [types, typeId]);

  const search = useCallback(async () => {
    if (!typeId) return;

    setSearching(true);
    setChosen(null);
    reset();

    try {
      const { data } = await api.get<Record<string, FreeSlot[]>>('/appointments/availability', {
        appointmentTypeId: typeId,
        providerId: providerId || undefined,
        departmentId: providerId ? undefined : departmentId || undefined,
        from,
        to,
      });
      setSlotsByDate(data);
      setSearched(true);
    } catch (caught) {
      capture(caught);
      setSlotsByDate({});
      setSearched(true);
    } finally {
      setSearching(false);
    }
  }, [typeId, providerId, departmentId, from, to, reset, capture]);

  async function book(): Promise<void> {
    if (!patient || !chosen || !typeId || booking) return;

    setBooking(true);
    reset();

    try {
      const { data } = await api.post<{ id: string }>('/appointments', {
        patientId: patient.id,
        providerId: chosen.providerId,
        appointmentTypeId: typeId,
        facilityId: chosen.facilityId ?? undefined,
        departmentId: type?.department_id ?? undefined,
        startsAt: chosen.startsAt,
        modality: chosen.modality,
        priority,
        bookingChannel: 'front_desk',
        reasonForVisit: reason || undefined,
        patientNotes: notes || undefined,
      });

      router.push(`/appointments?booked=${data.id}`);
    } catch (caught) {
      capture(caught);
      // A slot taken between search and submit is a 409. Re-running the search
      // is the only honest recovery — the list on screen is now wrong.
      if (caught instanceof ApiError && caught.status === 409) {
        setMessage(`${caught.message} The times below have been refreshed.`);
        void search();
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBooking(false);
    }
  }

  if (!can('appointment:write')) {
    return (
      <>
        <PageHeader title="Book an appointment" breadcrumbs={[{ label: 'Appointments', href: '/appointments' }]} />
        <Card>
          <Alert tone="info" title="Not available to your role">
            Booking needs the <code>appointment:write</code> permission.
          </Alert>
        </Card>
      </>
    );
  }

  const dates = Object.keys(slotsByDate).sort();
  const totalSlots = dates.reduce((sum, date) => sum + (slotsByDate[date]?.length ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Book an appointment"
        subtitle="Times come from the provider's rota and what is already booked — every slot shown is free"
        breadcrumbs={[{ label: 'Appointments', href: '/appointments' }, { label: 'Book' }]}
      />

      {message ? (
        <div className="mb-5">
          <Alert tone="critical" title="Not booked">
            {message}
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[22rem_1fr]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="Who" />
            <PatientPicker
              value={patient}
              onChange={setPatient}
              error={errors.patientId}
              autoFocus={!params.get('patientId')}
            />
          </Card>

          <Card>
            <CardHeader title="What" />
            <div className="flex flex-col gap-4">
              <Select
                name="appointmentTypeId"
                label="Appointment type"
                options={types.map((t) => ({
                  value: t.id,
                  label: `${t.name} · ${t.duration_minutes}m`,
                }))}
                value={typeId}
                error={errors.appointmentTypeId}
                onChange={(e) => {
                  setTypeId(e.target.value);
                  setSearched(false);
                  setSlotsByDate({});
                }}
              />

              {type ? (
                <div
                  className="rounded-[var(--radius-md)] p-3 text-[0.8125rem]"
                  style={{ background: 'var(--surface-sunken)', color: 'var(--ink-secondary)' }}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral" dot>
                      {humanise(type.modality)}
                    </Badge>
                    <span>
                      {type.duration_minutes} minutes
                      {type.buffer_after_minutes > 0 ? ` + ${type.buffer_after_minutes}m turnaround` : ''}
                    </span>
                  </span>
                  {type.base_price_cents > 0 ? (
                    <p className="mt-1.5">Catalogue price {formatMoney(type.base_price_cents)}</p>
                  ) : null}
                  {type.min_notice_hours > 0 ? (
                    <p className="mt-1">
                      Needs {pluralise(type.min_notice_hours, 'hour')} notice; slots inside that are not offered.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <Select
                name="providerId"
                label="Clinician"
                placeholder="Anyone in the department"
                options={providers.map((p) => ({ value: p.id, label: p.display_name }))}
                value={providerId}
                error={errors.providerId}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  setSearched(false);
                }}
              />

              {!providerId ? (
                <Select
                  name="departmentId"
                  label="Department"
                  placeholder="Choose one"
                  hint="Either a clinician or a department is needed to search"
                  options={(tenant?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))}
                  value={departmentId}
                  error={errors.departmentId}
                  onChange={(e) => {
                    setDepartmentId(e.target.value);
                    setSearched(false);
                  }}
                />
              ) : null}

              <div className="grid grid-cols-2 gap-3">
                <Field
                  name="from"
                  label="From"
                  type="date"
                  value={from}
                  max={to}
                  error={errors.from}
                  onChange={(e) => setFrom(e.target.value)}
                />
                <Field
                  name="to"
                  label="To"
                  type="date"
                  value={to}
                  min={from}
                  error={errors.to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>

              <Button
                type="button"
                variant="secondary"
                loading={searching}
                disabled={searching || !typeId || (!providerId && !departmentId)}
                onClick={() => void search()}
              >
                Find free times
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader title="Why" subtitle="Shown to the clinician before the visit" />
            <div className="flex flex-col gap-4">
              <Select
                name="priority"
                label="Priority"
                options={[
                  { value: 'routine', label: 'Routine' },
                  { value: 'follow_up', label: 'Follow-up' },
                  { value: 'urgent', label: 'Urgent' },
                  { value: 'emergency', label: 'Emergency' },
                ]}
                value={priority}
                error={errors.priority}
                onChange={(e) => setPriority(e.target.value)}
              />
              <Field
                name="reasonForVisit"
                label="Reason for visit"
                placeholder="Review of blood pressure"
                value={reason}
                error={errors.reasonForVisit}
                onChange={(e) => setReason(e.target.value)}
              />
              <TextArea
                name="patientNotes"
                label="Notes from the patient"
                rows={3}
                hint="Encrypted at rest — this is the patient's own account, not a clinical note"
                value={notes}
                error={errors.patientNotes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader
                title="Free times"
                subtitle={
                  searched
                    ? `${totalSlots} slot${totalSlots === 1 ? '' : 's'} across ${pluralise(dates.length, 'day')}`
                    : 'Choose a type and a clinician or department, then search'
                }
              />
            </div>

            {searching ? (
              <div className="flex flex-col gap-2 p-5 pt-0">
                <Skeleton height={64} />
                <Skeleton height={64} />
                <Skeleton height={64} />
              </div>
            ) : !searched ? (
              <EmptyState
                icon={<IconCalendar />}
                title="No search yet"
                description="Availability is computed from the rota, time off, the type's duration and what is already booked."
              />
            ) : dates.length === 0 ? (
              <EmptyState
                icon={<IconCalendar />}
                title="Nothing free in this window"
                description="Widen the dates, choose another clinician, or try a shorter appointment type."
              />
            ) : (
              <div className="flex flex-col gap-5 p-5 pt-0">
                {dates.map((date) => {
                  const slots = slotsByDate[date] ?? [];

                  return (
                    <div key={date}>
                      <h3
                        className="mb-2 text-[0.8125rem] font-semibold tracking-[0.02em] uppercase"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        {formatDate(date)}
                        <span className="ml-2 font-normal normal-case">
                          {pluralise(slots.length, 'time')}
                        </span>
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {slots.map((slot) => {
                          const active =
                            chosen?.startsAt === slot.startsAt && chosen?.providerId === slot.providerId;

                          return (
                            <button
                              key={`${slot.providerId}-${slot.startsAt}`}
                              type="button"
                              aria-pressed={active}
                              onClick={() => setChosen(slot)}
                              className="rounded-[var(--radius-md)] px-3 py-2 text-left"
                              style={{
                                background: active ? 'var(--accent-soft)' : 'var(--surface-sunken)',
                                border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
                              }}
                            >
                              <span
                                className="tabular block text-[0.875rem] font-medium"
                                style={{ color: active ? 'var(--info-ink)' : 'var(--ink)' }}
                              >
                                {slot.localTime}
                              </span>
                              <span className="block text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                                {slot.providerName}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {chosen ? (
            <Card>
              <CardHeader title="Confirm" subtitle={`Times shown in ${chosen.timezone}`} />
              <dl className="grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-[0.75rem] tracking-[0.02em] uppercase" style={{ color: 'var(--ink-muted)' }}>
                    Patient
                  </dt>
                  <dd className="text-[0.9375rem] font-medium" style={{ color: 'var(--ink)' }}>
                    {patient ? `${patient.fullName} · ${patient.mrn}` : 'Not chosen yet'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[0.75rem] tracking-[0.02em] uppercase" style={{ color: 'var(--ink-muted)' }}>
                    When
                  </dt>
                  <dd className="tabular text-[0.9375rem] font-medium" style={{ color: 'var(--ink)' }}>
                    {formatDate(chosen.localDate)} at {chosen.localTime}
                  </dd>
                </div>
                <div>
                  <dt className="text-[0.75rem] tracking-[0.02em] uppercase" style={{ color: 'var(--ink-muted)' }}>
                    Clinician
                  </dt>
                  <dd className="text-[0.9375rem]" style={{ color: 'var(--ink)' }}>
                    {chosen.providerName}
                  </dd>
                </div>
                <div>
                  <dt className="text-[0.75rem] tracking-[0.02em] uppercase" style={{ color: 'var(--ink-muted)' }}>
                    Type
                  </dt>
                  <dd className="text-[0.9375rem]" style={{ color: 'var(--ink)' }}>
                    {type?.name ?? '—'}
                  </dd>
                </div>
              </dl>

              <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                <Link href="/appointments">
                  <Button type="button" variant="ghost">
                    Cancel
                  </Button>
                </Link>
                <Button
                  type="button"
                  variant="primary"
                  loading={booking}
                  disabled={booking || !patient}
                  onClick={() => void book()}
                >
                  {patient ? 'Book this time' : 'Choose a patient first'}
                </Button>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
