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
            <Button variant="primary" icon={<IconCalendar />}>
              Book appointment
            </Button>
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
                        ) : appointment.status === 'checked_in' ? (
                          <a
                            href={`/patients/${appointment.patientId}`}
                            className="inline-flex items-center gap-1 text-[0.8125rem]"
                            style={{ color: 'var(--accent)' }}
                          >
                            Open chart
                            <IconChevronRight className="h-3.5 w-3.5" />
                          </a>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
