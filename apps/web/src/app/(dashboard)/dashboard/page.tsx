'use client';

/**
 * Operational dashboard.
 *
 * COMPOSITION, in the order a shift actually needs it:
 *
 *  1. Anything clinically unsafe, as an interrupting banner. An unacknowledged
 *     critical lab result is not a tile on a grid — it is the only thing that
 *     matters on the screen until someone deals with it.
 *  2. A KPI row of stat tiles. These are unrelated measures, so they are tiles,
 *     not a grouped bar chart — the single most common dashboard mistake.
 *  3. The clinic timeline: where the day is, right now.
 *  4. Supporting panels (stock, money), permission-gated.
 *
 * Everything is one API round trip for the metrics plus one per panel, because
 * this page is loaded by every member of staff at the start of every shift.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Meter,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
  type Tone,
} from '@/components/ui/primitives';
import { AgeingBar } from '@/components/charts/ageing-bar';
import { DayTimeline } from '@/components/charts/day-timeline';
import { useSession } from '@/lib/session';
import {
  api,
  type AppointmentListItem,
  type DashboardMetrics,
  type StockStatusItem,
} from '@/lib/api';
import { formatMoney, formatNumber, formatTime, humanise, pluralise } from '@/lib/format';
import { IconAlert, IconCalendar, IconPlus } from '@/components/layout/icons';

const STOCK_TONE: Record<StockStatusItem['stockState'], Tone> = {
  out_of_stock: 'critical',
  critical: 'critical',
  low: 'warning',
  overstocked: 'info',
  ok: 'good',
};

export default function DashboardPage() {
  const { user, can, canAny } = useSession();

  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [appointments, setAppointments] = useState<AppointmentListItem[]>([]);
  const [stock, setStock] = useState<StockStatusItem[]>([]);
  const [ageing, setAgeing] = useState<Record<string, { totalCents: number; count: number }>>({});
  const [loading, setLoading] = useState(true);

  const today = new Date().toISOString().slice(0, 10);

  const load = useCallback(async () => {
    setLoading(true);

    // Panels are fetched in parallel and failures are isolated: a billing
    // outage must not blank the clinic list.
    const results = await Promise.allSettled([
      canAny('report:operational', 'report:clinical', 'report:financial')
        ? api.get<DashboardMetrics>('/reports/dashboard')
        : Promise.resolve(null),
      can('appointment:read')
        ? api.get<AppointmentListItem[]>('/appointments', { from: today, to: today, pageSize: 200 })
        : Promise.resolve(null),
      can('inventory:read')
        ? api.get<StockStatusItem[]>('/inventory/stock', { pageSize: 50 })
        : Promise.resolve(null),
      can('invoice:read') ? api.get<unknown>('/billing/invoices', { pageSize: 1 }) : Promise.resolve(null),
    ]);

    const [metricsResult, appointmentsResult, stockResult, billingResult] = results;

    if (metricsResult.status === 'fulfilled' && metricsResult.value) {
      setMetrics(metricsResult.value.data);
    }
    if (appointmentsResult.status === 'fulfilled' && appointmentsResult.value) {
      setAppointments(appointmentsResult.value.data);
    }
    if (stockResult.status === 'fulfilled' && stockResult.value) {
      setStock(stockResult.value.data.filter((item) => item.stockState !== 'ok'));
    }
    if (billingResult.status === 'fulfilled' && billingResult.value) {
      const meta = billingResult.value.meta as
        | { ageing?: Record<string, { totalCents: number; count: number }> }
        | undefined;
      setAgeing(meta?.ageing ?? {});
    }

    setLoading(false);
  }, [can, canAny, today]);

  useEffect(() => {
    void load();
  }, [load]);

  const greeting = (() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  })();

  const waiting = appointments.filter((a) => a.status === 'checked_in');
  const firstName = user?.fullName.split(' ')[0] ?? '';

  return (
    <>
      <PageHeader
        title={`${greeting}, ${firstName}`}
        subtitle={new Intl.DateTimeFormat(undefined, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        }).format(new Date())}
        actions={
          <>
            {can('patient:write') ? (
              <Button variant="secondary" icon={<IconPlus />} onClick={() => (window.location.href = '/patients?new=1')}>
                Register patient
              </Button>
            ) : null}
            {can('appointment:write') ? (
              <Button variant="primary" icon={<IconCalendar />} onClick={() => (window.location.href = '/appointments?book=1')}>
                Book appointment
              </Button>
            ) : null}
          </>
        }
      />

      {/* ---- 1. Safety interrupts ---------------------------------------- */}
      {metrics && metrics.critical_results_unacknowledged > 0 ? (
        <div className="mb-4">
          <Alert
            tone="critical"
            title={`${pluralise(metrics.critical_results_unacknowledged, 'critical result')} awaiting acknowledgement`}
            action={
              <Button size="sm" variant="danger" onClick={() => (window.location.href = '/clinical?critical=1')}>
                Review now
              </Button>
            }
          >
            A result flagged critical has not been seen by a clinician. These escalate until
            acknowledged.
          </Alert>
        </div>
      ) : null}

      {metrics && metrics.unsigned_notes_overdue > 0 ? (
        <div className="mb-4">
          <Alert tone="warning" title={`${pluralise(metrics.unsigned_notes_overdue, 'note')} unsigned for over 24 hours`}>
            An unsigned encounter is not yet part of the legal record and cannot be billed.
          </Alert>
        </div>
      ) : null}

      {/* ---- 2. KPI row -------------------------------------------------- */}
      {loading && !metrics ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}>
              <Skeleton className="w-24" height={12} />
              <Skeleton className="mt-3 w-16" height={28} />
            </Card>
          ))}
        </div>
      ) : metrics ? (
        <section aria-label="Today at a glance" className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Clinic today"
            value={formatNumber(metrics.appointments_today)}
            hint={
              metrics.in_consultation > 0
                ? `${metrics.in_consultation} in consultation now`
                : 'No consultations in progress'
            }
            href="/appointments"
          />

          <StatTile
            label="Waiting now"
            value={formatNumber(metrics.waiting_now)}
            tone={metrics.waiting_now > 8 ? 'warning' : 'neutral'}
            hint={
              metrics.median_wait_minutes !== null
                ? `Median wait ${Math.round(metrics.median_wait_minutes)} min`
                : 'No one checked in yet'
            }
            href="/appointments"
          />

          <StatTile
            label="Active patients"
            value={formatNumber(metrics.active_patients)}
            hint={`${formatNumber(metrics.new_patients_30d)} registered in 30 days`}
            href="/patients"
          />

          {can('report:financial') ? (
            <StatTile
              label="Collected today"
              value={formatMoney(metrics.collected_today_cents)}
              tone="good"
              hint={
                metrics.outstanding_balance_cents !== null
                  ? `${formatMoney(metrics.outstanding_balance_cents)} outstanding`
                  : undefined
              }
              href="/billing"
            />
          ) : (
            <StatTile
              label="Prescriptions pending"
              value={formatNumber(metrics.prescriptions_pending)}
              tone={metrics.prescriptions_pending > 20 ? 'warning' : 'neutral'}
              hint="Awaiting dispensing"
              href="/pharmacy"
            />
          )}
        </section>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-5">
          {/* ---- 3. Clinic timeline ------------------------------------- */}
          {can('appointment:read') ? (
            <Card>
              <CardHeader
                title="Clinic timeline"
                subtitle="Today, by clinician. The red line marks the current time."
                action={
                  <Link href="/appointments" className="text-[0.8125rem]" style={{ color: 'var(--accent)' }}>
                    Full calendar →
                  </Link>
                }
              />
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
          ) : null}

          {/* ---- Waiting room ------------------------------------------- */}
          {can('appointment:read') ? (
            <Card>
              <CardHeader
                title="Waiting room"
                subtitle={
                  waiting.length > 0
                    ? `${pluralise(waiting.length, 'patient')} checked in`
                    : 'Nobody is currently waiting'
                }
              />
              {waiting.length === 0 ? (
                <EmptyState
                  title="Waiting room is clear"
                  description="Patients appear here once the front desk checks them in."
                />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Patient</Th>
                      <Th>MRN</Th>
                      <Th>Clinician</Th>
                      <Th>Slot</Th>
                      <Th>Waiting</Th>
                      <Th align="right">Reason</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {waiting.map((appointment) => {
                      const waitMinutes = appointment.checkedInAt
                        ? Math.round((Date.now() - new Date(appointment.checkedInAt).getTime()) / 60_000)
                        : 0;

                      return (
                        <Tr key={appointment.id} href={`/patients/${appointment.patientId}`}>
                          <Td className="font-medium">{appointment.patientName}</Td>
                          <Td numeric>{appointment.patientMrn}</Td>
                          <Td>{appointment.providerName}</Td>
                          <Td numeric>{formatTime(appointment.startsAt)}</Td>
                          <Td>
                            <Badge tone={waitMinutes > 30 ? 'warning' : 'neutral'} dot={waitMinutes <= 30}>
                              {waitMinutes} min
                            </Badge>
                          </Td>
                          <Td align="right" className="max-w-[12rem] truncate">
                            {appointment.reasonForVisit ?? '—'}
                          </Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </Card>
          ) : null}
        </div>

        {/* ---- 4. Supporting panels ------------------------------------- */}
        <div className="flex flex-col gap-5">
          {can('inventory:read') ? (
            <Card>
              <CardHeader
                title="Stock needing attention"
                subtitle="Items at or below their reorder level"
                action={
                  <Link href="/inventory" className="text-[0.8125rem]" style={{ color: 'var(--accent)' }}>
                    All stock →
                  </Link>
                }
              />
              {stock.length === 0 ? (
                <EmptyState title="Every item is in stock" description="Nothing is below its reorder level." />
              ) : (
                <ul className="flex flex-col gap-3.5">
                  {stock.slice(0, 6).map((item) => (
                    <li key={`${item.itemId}-${item.locationId}`}>
                      <div className="mb-1.5 flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-[0.875rem] font-medium" style={{ color: 'var(--ink)' }}>
                            {item.name}
                          </p>
                          <p className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                            {item.locationName}
                            {item.controlledSchedule ? ` · Schedule ${item.controlledSchedule}` : ''}
                          </p>
                        </div>
                        <Badge tone={STOCK_TONE[item.stockState]}>{humanise(item.stockState)}</Badge>
                      </div>

                      <Meter
                        value={item.quantityAvailable}
                        max={Math.max(item.reorderLevel * 2, item.quantityAvailable, 1)}
                        threshold={item.reorderLevel}
                        tone={STOCK_TONE[item.stockState]}
                        label={`${item.name} stock level`}
                      />

                      <div
                        className="tabular mt-1 flex justify-between text-[0.75rem]"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        <span>
                          {formatNumber(item.quantityAvailable)} {item.baseUnit} left
                        </span>
                        <span>
                          {item.daysOfCover !== null ? `~${item.daysOfCover} days cover` : 'No usage data'}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}

          {can('report:financial') ? (
            <Card>
              <CardHeader title="Receivables ageing" subtitle="Outstanding balance by age of debt" />
              <AgeingBar buckets={ageing} />
            </Card>
          ) : null}

          {/* Compliance panel: only for those who review it. */}
          {can('audit:read') && metrics ? (
            <Card>
              <CardHeader title="Compliance" subtitle="Items needing a privacy or credential review" />
              <ul className="flex flex-col gap-2.5">
                <ComplianceRow
                  label="Emergency access awaiting review"
                  value={metrics.break_glass_pending_review}
                  href="/reports?view=break-glass"
                  tone={metrics.break_glass_pending_review > 0 ? 'warning' : 'good'}
                />
                <ComplianceRow
                  label="Licences expiring within 60 days"
                  value={metrics.licences_expiring_soon}
                  href="/staff?expiring=1"
                  tone={metrics.licences_expiring_soon > 0 ? 'warning' : 'good'}
                />
                <ComplianceRow
                  label="Batches expiring within 30 days"
                  value={metrics.batches_expiring_30d}
                  href="/inventory?expiring=1"
                  tone={metrics.batches_expiring_30d > 0 ? 'serious' : 'good'}
                />
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function ComplianceRow({
  label,
  value,
  href,
  tone,
}: {
  label: string;
  value: number;
  href: string;
  tone: Tone;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] px-2 py-1.5 transition-colors hover:[background:var(--surface-hover)]"
      >
        <span className="flex items-center gap-2 text-[0.8125rem]" style={{ color: 'var(--ink-secondary)' }}>
          {value > 0 ? <IconAlert className="h-4 w-4 shrink-0" /> : null}
          {label}
        </span>
        <Badge tone={tone}>{formatNumber(value)}</Badge>
      </Link>
    </li>
  );
}
