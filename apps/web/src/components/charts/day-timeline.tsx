'use client';

/**
 * Clinic day timeline.
 *
 * Not a chart in the statistical sense — a scheduling gantt, where position
 * encodes time and the reader's job is "what is happening now, and where are
 * the gaps". The now-line is the point of it: a clinic board without one makes
 * the user compute their own position in the day.
 *
 * Status is carried by a glyph and a label in each block, never by fill alone.
 */
import type { ReactNode } from 'react';
import type { AppointmentListItem } from '@/lib/api';
import { formatTime } from '@/lib/format';

const STATUS_STYLE: Record<string, { fill: string; ink: string; glyph: string; label: string }> = {
  scheduled: { fill: 'var(--surface-sunken)', ink: 'var(--ink-secondary)', glyph: '·', label: 'Scheduled' },
  confirmed: { fill: 'var(--accent-soft)', ink: 'var(--info-ink)', glyph: '✓', label: 'Confirmed' },
  checked_in: { fill: 'var(--warning-soft)', ink: 'var(--warning-ink)', glyph: '◆', label: 'Waiting' },
  in_progress: { fill: 'var(--good-soft)', ink: 'var(--good-ink)', glyph: '▶', label: 'In consult' },
  completed: { fill: 'var(--surface-sunken)', ink: 'var(--ink-muted)', glyph: '✓', label: 'Done' },
  cancelled: { fill: 'var(--surface-sunken)', ink: 'var(--ink-muted)', glyph: '×', label: 'Cancelled' },
  no_show: { fill: 'var(--critical-soft)', ink: 'var(--critical-ink)', glyph: '!', label: 'No show' },
};

/** Outer bounds: a clinic board never needs to show the small hours. */
const EARLIEST_HOUR = 6;
const LATEST_HOUR = 22;
/** Below this the blocks are too narrow to label, so the window never shrinks past it. */
const MIN_WINDOW_HOURS = 5;

function hourFraction(iso: string): number {
  const date = new Date(iso);
  return date.getHours() + date.getMinutes() / 60;
}

/**
 * Fit the window to the day's actual bookings.
 *
 * A fixed 07:00–20:00 axis renders a 30-minute appointment at under 4% width —
 * narrow enough that the patient's name is unreadable, which defeats the point
 * of the board. Framing the axis around the booked range (padded to whole
 * hours, and never narrower than MIN_WINDOW_HOURS) keeps a quiet day legible
 * while a full clinic still fits.
 */
function computeWindow(appointments: AppointmentListItem[]): { start: number; end: number } {
  const now = new Date();
  const nowHour = now.getHours() + now.getMinutes() / 60;

  if (appointments.length === 0) {
    const start = Math.max(EARLIEST_HOUR, Math.floor(nowHour) - 2);
    return { start, end: Math.min(LATEST_HOUR, start + 8) };
  }

  const starts = appointments.map((a) => hourFraction(a.startsAt));
  const ends = appointments.map((a) => hourFraction(a.endsAt));

  let start = Math.floor(Math.min(...starts)) - 1;
  let end = Math.ceil(Math.max(...ends)) + 1;

  // Keep "now" on the axis, so the red line stays meaningful.
  if (nowHour >= EARLIEST_HOUR && nowHour <= LATEST_HOUR) {
    start = Math.min(start, Math.floor(nowHour));
    end = Math.max(end, Math.ceil(nowHour));
  }

  start = Math.max(EARLIEST_HOUR, start);
  end = Math.min(LATEST_HOUR, end);

  if (end - start < MIN_WINDOW_HOURS) {
    const deficit = MIN_WINDOW_HOURS - (end - start);
    start = Math.max(EARLIEST_HOUR, start - Math.ceil(deficit / 2));
    end = Math.min(LATEST_HOUR, start + MIN_WINDOW_HOURS);
  }

  return { start, end };
}

export function DayTimeline({
  appointments,
  onSelect,
}: {
  appointments: AppointmentListItem[];
  onSelect?: (appointment: AppointmentListItem) => void;
}): ReactNode {
  const { start: windowStart, end: windowEnd } = computeWindow(appointments);
  const span = windowEnd - windowStart;
  const hours = Array.from({ length: span + 1 }, (_, i) => windowStart + i);

  const now = new Date();
  const nowFraction = now.getHours() + now.getMinutes() / 60;
  const nowVisible = nowFraction >= windowStart && nowFraction <= windowEnd;

  // One lane per provider, so overlapping clinics do not stack illegibly.
  const providers = [...new Map(appointments.map((a) => [a.providerId, a.providerName])).entries()];

  if (providers.length === 0) {
    return (
      <p className="py-8 text-center text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
        No clinics scheduled for this day.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[48rem]">
        {/* Hour axis: recessive, hairline gridlines */}
        <div className="relative mb-1.5 ml-[9.5rem] h-5">
          {hours.map((hour, index) => {
            // The first and last ticks sit on the container edge; centring
            // them there clips half the label, so they anchor inward instead.
            const isFirst = index === 0;
            const isLast = index === hours.length - 1;

            return (
              <span
                key={hour}
                className="tabular absolute text-[0.6875rem]"
                style={{
                  left: `${((hour - windowStart) / span) * 100}%`,
                  transform: isFirst ? 'none' : isLast ? 'translateX(-100%)' : 'translateX(-50%)',
                  color: 'var(--chart-label)',
                }}
              >
                {String(hour).padStart(2, '0')}
              </span>
            );
          })}
        </div>

        <div className="flex flex-col gap-1.5">
          {providers.map(([providerId, providerName]) => {
            const lane = appointments.filter((a) => a.providerId === providerId);

            return (
              <div key={providerId} className="flex items-stretch gap-2">
                <div
                  className="flex w-[9rem] shrink-0 items-center truncate pr-1 text-[0.8125rem] font-medium"
                  style={{ color: 'var(--ink-secondary)' }}
                  title={providerName}
                >
                  {providerName}
                </div>

                <div
                  className="relative h-11 flex-1 rounded-[var(--radius-sm)]"
                  style={{ background: 'var(--surface-sunken)' }}
                >
                  {/* Hairline gridlines, behind the marks */}
                  {hours.map((hour) => (
                    <div
                      key={hour}
                      aria-hidden="true"
                      className="absolute inset-y-0"
                      style={{
                        left: `${((hour - windowStart) / span) * 100}%`,
                        width: 1,
                        background: 'var(--chart-grid)',
                      }}
                    />
                  ))}

                  {nowVisible ? (
                    <div
                      aria-hidden="true"
                      className="absolute inset-y-0 z-10"
                      style={{
                        left: `${((nowFraction - windowStart) / span) * 100}%`,
                        width: 2,
                        background: 'var(--critical)',
                      }}
                      title="Now"
                    />
                  ) : null}

                  {lane.map((appointment) => {
                    const start = hourFraction(appointment.startsAt);
                    const end = hourFraction(appointment.endsAt);
                    const left = ((start - windowStart) / span) * 100;
                    const width = ((end - start) / span) * 100;
                    // Below roughly this width the name cannot be read, so the
                    // block falls back to its glyph alone plus the tooltip.
                    const showLabel = width >= 7;
                    const style = STATUS_STYLE[appointment.status] ?? STATUS_STYLE.scheduled!;

                    if (left < -5 || left > 105) return null;

                    return (
                      <button
                        key={appointment.id}
                        type="button"
                        onClick={() => onSelect?.(appointment)}
                        className="absolute top-1 bottom-1 overflow-hidden rounded-[var(--radius-xs)] px-1.5 text-left transition-[filter] hover:brightness-95"
                        style={{
                          left: `${Math.max(0, left)}%`,
                          // 2px surface gap between adjacent blocks, so two
                          // back-to-back slots do not read as one.
                          width: `calc(${Math.max(width, 3.5)}% - 2px)`,
                          background: style.fill,
                          color: style.ink,
                          // Type colour as a 3px left rule: identity without
                          // letting an arbitrary hex drive the whole fill.
                          borderLeft: `3px solid ${appointment.typeColour}`,
                        }}
                        title={`${formatTime(appointment.startsAt)} · ${appointment.patientName} (${appointment.patientMrn}) · ${appointment.appointmentType} · ${style.label}`}
                      >
                        {showLabel ? (
                          <>
                            <span className="flex items-center gap-1 text-[0.6875rem] leading-tight font-semibold">
                              <span aria-hidden="true">{style.glyph}</span>
                              <span className="truncate">{appointment.patientName}</span>
                            </span>
                            <span
                              className="tabular block truncate text-[0.625rem] leading-tight"
                              style={{ opacity: 0.8 }}
                            >
                              {formatTime(appointment.startsAt)} · {style.label}
                            </span>
                          </>
                        ) : (
                          <span className="flex h-full items-center justify-center text-[0.75rem] font-bold">
                            <span aria-hidden="true">{style.glyph}</span>
                            <span className="sr-only">
                              {appointment.patientName}, {formatTime(appointment.startsAt)}, {style.label}
                            </span>
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Legend: present because more than one status is on screen, and each
            entry pairs its glyph with its label. */}
        <ul className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {['confirmed', 'checked_in', 'in_progress', 'completed', 'no_show'].map((key) => {
            const style = STATUS_STYLE[key]!;
            return (
              <li key={key} className="flex items-center gap-1.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                <span
                  aria-hidden="true"
                  className="flex h-3.5 w-3.5 items-center justify-center rounded-[2px] text-[0.5625rem] font-bold"
                  style={{ background: style.fill, color: style.ink }}
                >
                  {style.glyph}
                </span>
                {style.label}
              </li>
            );
          })}
          <li className="flex items-center gap-1.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
            <span aria-hidden="true" className="inline-block h-3.5 w-[2px]" style={{ background: 'var(--critical)' }} />
            Now
          </li>
        </ul>
      </div>
    </div>
  );
}
