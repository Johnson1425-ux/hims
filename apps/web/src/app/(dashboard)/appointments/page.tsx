'use client';

/**
 * Appointments.
 *
 * The day view is the default because that is the question the front desk
 * actually has ("who is coming in today, and who has arrived?"). The slot
 * picker is a separate, explicit flow rather than drag-to-create, because a
 * mis-drag that books the wrong patient is expensive to unwind.
 *
 * The free-slot list is a HINT, not a reservation: the database holds the
 * exclusion constraint, so a slot can be taken between render and click. The
 * resulting 409 is surfaced as a plain "just taken, pick another" rather than
 * an error dialog.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Skeleton,
  Table,
  Td,
  Th,
  Tr,
  type Tone,
} from '@/components/ui/primitives';
import { DayTimeline } from '@/components/charts/day-timeline';
import { useSession } from '@/lib/session';
import { api, ApiError, type AppointmentListItem } from '@/lib/api';
import { formatTime, humanise, pluralise } from '@/lib/format';
import { IconCalendar, IconChevronRight } from '@/components/layout/icons';
import { Checkbox, Field, FormDialog, TextArea, useFormErrors } from '@/components/ui/forms';

const STATUS_TONE: Record<string, Tone> = {
  scheduled: 'neutral',
  confirmed: 'info',
  checked_in: 'warning',
  in_progress: 'good',
  completed: 'neutral',
  cancelled: 'neutral',
  no_show: 'critical',
  rescheduled: 'neutral',
};

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export default function AppointmentsPage() {
  const { can } = useSession();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [appointments, setAppointments] = useState<AppointmentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: Tone; message: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<AppointmentListItem | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [releaseSlot, setReleaseSlot] = useState(true);
  const [moving, setMoving] = useState<AppointmentListItem | null>(null);
  const [newStart, setNewStart] = useState('');
  const [moveReason, setMoveReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<AppointmentListItem[]>('/appointments', {
        from: date,
        to: date,
        pageSize: 200,
      });
      setAppointments(data);
    } catch (caught) {
      if (caught instanceof ApiError) setNotice({ tone: 'critical', message: caught.message });
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Cancelling asks for a reason and defaults to releasing the slot.
   *
   * The reason is required by the API, not by politeness: a cancellation rate
   * is only actionable if you know whether the hospital or the patient
   * cancelled, and "no reason recorded" is the answer that makes the
   * utilisation report useless. Releasing to the waitlist is the default
   * because a freed slot that nobody is offered is a slot wasted twice.
   */
  async function cancel(): Promise<void> {
    if (!cancelling) return;

    cancelForm.reset();

    try {
      await api.post(`/appointments/${cancelling.id}/cancel`, {
        reason: cancelReason,
        releaseToWaitlist: releaseSlot,
      });
      setNotice({ tone: 'good', message: `${cancelling.patientName}'s appointment was cancelled.` });
      setCancelling(null);
      setCancelReason('');
      await load();
    } catch (caught) {
      cancelForm.capture(caught);
    }
  }

  async function reschedule(): Promise<void> {
    if (!moving || !newStart) return;

    moveForm.reset();

    try {
      // datetime-local has no zone, so it is read in the browser's zone and
      // sent as an absolute instant — which is what the column stores.
      await api.post(`/appointments/${moving.id}/reschedule`, {
        startsAt: new Date(newStart).toISOString(),
        reason: moveReason || undefined,
      });
      setNotice({ tone: 'good', message: `${moving.patientName}'s appointment was moved.` });
      setMoving(null);
      setNewStart('');
      setMoveReason('');
      await load();
    } catch (caught) {
      moveForm.capture(caught);
    }
  }

  async function checkIn(appointment: AppointmentListItem) {
    setBusyId(appointment.id);
    setNotice(null);

    try {
      await api.post(`/appointments/${appointment.id}/check-in`, {});
      setNotice({ tone: 'good', message: `${appointment.patientName} checked in.` });
      await load();
    } catch (caught) {
      if (caught instanceof ApiError) setNotice({ tone: 'warning', message: caught.message });
    } finally {
      setBusyId(null);
    }
  }

  const cancelForm = useFormErrors();
  const moveForm = useFormErrors();

  const counts = useMemo(() => {
    const byStatus = appointments.reduce<Record<string, number>>((acc, appointment) => {
      acc[appointment.status] = (acc[appointment.status] ?? 0) + 1;
      return acc;
    }, {});

    return {
      total: appointments.length,
      waiting: byStatus.checked_in ?? 0,
      inProgress: byStatus.in_progress ?? 0,
      completed: byStatus.completed ?? 0,
      noShow: byStatus.no_show ?? 0,
    };
  }, [appointments]);

  const isToday = date === new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title="Appointments"
        subtitle={
          loading
            ? 'Loading…'
            : `${pluralise(counts.total, 'appointment')} · ${counts.waiting} waiting · ${counts.completed} completed`
        }
        actions={
          can('appointment:write') ? (
            <Link href="/appointments/new">
              <Button variant="primary" icon={<IconCalendar />}>
                Book appointment
              </Button>
            </Link>
          ) : null
        }
      />

      {notice ? (
        <div className="mb-4">
          <Alert tone={notice.tone}>{notice.message}</Alert>
        </div>
      ) : null}

      {/* Date control: one row above the content, as a single group. */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">
          ←
        </Button>
        <input
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          aria-label="Clinic date"
          className="h-8 rounded-[var(--radius-md)] px-2.5 text-[0.8125rem]"
          style={{
            background: 'var(--surface)',
            color: 'var(--ink)',
            border: '1px solid var(--line-strong)',
          }}
        />
        <Button size="sm" onClick={() => setDate(addDays(date, 1))} aria-label="Next day">
          →
        </Button>
        {!isToday ? (
          <Button size="sm" variant="ghost" onClick={() => setDate(new Date().toISOString().slice(0, 10))}>
            Back to today
          </Button>
        ) : (
          <Badge tone="info" dot>
            Today
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader title="Day at a glance" subtitle="Each lane is one clinician" />
          {loading ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height={44} />
              ))}
            </div>
          ) : (
            <DayTimeline appointments={appointments} />
          )}
        </Card>

        <Card padded={false}>
          <div className="p-5 pb-0">
            <CardHeader
              title="Schedule"
              subtitle={
                counts.noShow > 0
                  ? `${pluralise(counts.noShow, 'no-show')} recorded for this day`
                  : undefined
              }
            />
          </div>

          {loading && appointments.length === 0 ? (
            <div className="flex flex-col gap-2 p-5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} height={44} />
              ))}
            </div>
          ) : appointments.length === 0 ? (
            <EmptyState
              icon={<IconCalendar />}
              title="No appointments on this day"
              description="Pick another date, or book a new appointment."
            />
          ) : (
            <div className="px-5 pb-1">
              <Table>
                <thead>
                  <tr>
                    <Th width="5rem">Time</Th>
                    <Th>Patient</Th>
                    <Th>MRN</Th>
                    <Th>Clinician</Th>
                    <Th>Type</Th>
                    <Th>Reason</Th>
                    <Th width="7rem">Status</Th>
                    <Th align="right" width="8rem" />
                  </tr>
                </thead>
                <tbody>
                  {appointments.map((appointment) => (
                    <Tr key={appointment.id}>
                      <Td numeric className="font-medium">
                        {formatTime(appointment.startsAt)}
                      </Td>
                      <Td>
                        <a
                          href={`/patients/${appointment.patientId}`}
                          className="font-medium hover:underline"
                          style={{ color: 'var(--ink)' }}
                        >
                          {appointment.patientName}
                        </a>
                      </Td>
                      <Td numeric style={{ color: 'var(--ink-muted)' }}>
                        {appointment.patientMrn}
                      </Td>
                      <Td>{appointment.providerName}</Td>
                      <Td>
                        <span className="flex items-center gap-1.5">
                          <span
                            aria-hidden="true"
                            className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                            style={{ background: appointment.typeColour }}
                          />
                          {appointment.appointmentType}
                        </span>
                      </Td>
                      <Td className="max-w-[12rem] truncate" style={{ color: 'var(--ink-muted)' }}>
                        {appointment.reasonForVisit ?? '—'}
                      </Td>
                      <Td>
                        <Badge
                          tone={STATUS_TONE[appointment.status] ?? 'neutral'}
                          dot={appointment.status === 'scheduled'}
                        >
                          {humanise(appointment.status)}
                        </Badge>
                      </Td>
                      <Td align="right">
                        <span className="flex flex-wrap items-center justify-end gap-1.5">
                          {can('appointment:checkin') &&
                          ['scheduled', 'confirmed'].includes(appointment.status) ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={busyId === appointment.id}
                              onClick={() => void checkIn(appointment)}
                            >
                              Check in
                            </Button>
                          ) : null}

                          {appointment.status === 'checked_in' ? (
                            <Link
                              href={`/patients/${appointment.patientId}`}
                              className="inline-flex items-center gap-1 text-[0.8125rem]"
                              style={{ color: 'var(--accent)' }}
                            >
                              Open chart
                              <IconChevronRight className="h-3.5 w-3.5" />
                            </Link>
                          ) : null}

                          {can('appointment:write') &&
                          ['scheduled', 'confirmed'].includes(appointment.status) ? (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setMoving(appointment);
                                  setNewStart(appointment.startsAt.slice(0, 16));
                                  moveForm.reset();
                                }}
                              >
                                Move
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setCancelling(appointment);
                                  setCancelReason('');
                                  setReleaseSlot(true);
                                  cancelForm.reset();
                                }}
                              >
                                Cancel
                              </Button>
                            </>
                          ) : null}
                        </span>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card>
      </div>

      <FormDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Cancel this appointment"
        description={
          cancelling
            ? `${cancelling.patientName} · ${formatTime(cancelling.startsAt)} with ${cancelling.providerName}`
            : undefined
        }
        submitLabel="Cancel the appointment"
        submitTone="danger"
        message={cancelForm.message}
        disabled={cancelReason.trim().length === 0}
        onSubmit={cancel}
      >
        <TextArea
          name="reason"
          label="Why is it being cancelled?"
          required
          rows={3}
          hint="Recorded against the appointment. A cancellation rate is only actionable if the reason is known."
          value={cancelReason}
          error={cancelForm.errors.reason}
          onChange={(event) => setCancelReason(event.target.value)}
        />
        <Checkbox
          name="releaseToWaitlist"
          label="Offer the freed slot to the waitlist"
          hint="Patients waiting for this clinician are offered it automatically."
          checked={releaseSlot}
          onChange={(event) => setReleaseSlot(event.target.checked)}
        />
      </FormDialog>

      <FormDialog
        open={moving !== null}
        onClose={() => setMoving(null)}
        title="Move this appointment"
        description={
          moving
            ? `${moving.patientName} · currently ${formatTime(moving.startsAt)} with ${moving.providerName}`
            : undefined
        }
        submitLabel="Move it"
        message={moveForm.message}
        disabled={!newStart}
        onSubmit={reschedule}
      >
        <Field
          name="startsAt"
          label="New start time"
          type="datetime-local"
          required
          hint="The booking constraint still applies — a time the clinician already has is refused."
          value={newStart}
          error={moveForm.errors.startsAt}
          onChange={(event) => setNewStart(event.target.value)}
        />
        <Field
          name="moveReason"
          label="Reason"
          placeholder="Clinic overran"
          value={moveReason}
          error={moveForm.errors.reason}
          onChange={(event) => setMoveReason(event.target.value)}
        />
      </FormDialog>
    </>
  );
}
