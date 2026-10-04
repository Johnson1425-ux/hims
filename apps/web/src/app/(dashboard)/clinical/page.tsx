'use client';

/**
 * Encounter worklist.
 *
 * Ordered by NEWS2 descending, not by time. A deteriorating patient and a
 * routine medication review are both "unsigned notes", and sorting them
 * chronologically puts the sick one wherever the clock happens to place them.
 * The physiology decides the order; the clock is a tiebreak.
 *
 * The default filter is unsigned work, because that is what this screen is
 * opened to find: an unsigned note is an unbillable encounter and a compliance
 * exposure at the same time, and the dashboard counts them without offering
 * anywhere to go. No narrative is shown here — the worklist endpoint returns
 * none, so a board left open on a ward screen names who is being seen, not
 * what was said. The note itself is read from the patient's chart, where the
 * access decision and the audit entry belong.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
  type Tone,
} from '@/components/ui/primitives';
import { useSession } from '@/lib/session';
import { api, ApiError, type EncounterWorklistItem } from '@/lib/api';
import { formatDateTime, formatRelative, humanise, pluralise } from '@/lib/format';
import { IconStethoscope, IconChevronRight } from '@/components/layout/icons';

const STATUS_TONE: Record<EncounterWorklistItem['status'], Tone> = {
  draft: 'warning',
  in_progress: 'info',
  pending_signature: 'serious',
  signed: 'good',
  amended: 'neutral',
  voided: 'neutral',
};

/**
 * NEWS2 banding, from the Royal College of Physicians' chart. The thresholds
 * are not arbitrary and must not be prettified: 7 or more is the emergency
 * response trigger, 5 is the urgent review threshold, and a single parameter
 * scoring 3 also escalates.
 */
function news2Tone(score: number | null): Tone {
  if (score === null) return 'neutral';
  if (score >= 7) return 'critical';
  if (score >= 5) return 'serious';
  if (score >= 1) return 'warning';
  return 'good';
}

function news2Label(score: number | null): string {
  if (score === null) return 'No observations';
  if (score >= 7) return 'Emergency response';
  if (score >= 5) return 'Urgent review';
  if (score >= 1) return 'Low risk';
  return 'Routine';
}

type Filter = 'unsigned' | 'open' | 'signed' | 'all';

const FILTERS: Array<{ value: Filter; label: string; hint: string }> = [
  { value: 'unsigned', label: 'Unsigned', hint: 'Drafted, in progress or awaiting signature' },
  { value: 'open', label: 'Still open', hint: 'No end time recorded' },
  { value: 'signed', label: 'Signed', hint: 'Locked; corrections are filed as amendments' },
  { value: 'all', label: 'Everything', hint: 'Every encounter, newest physiology first' },
];

export default function ClinicalPage() {
  const { can, user } = useSession();
  const [items, setItems] = useState<EncounterWorklistItem[]>([]);
  const [filter, setFilter] = useState<Filter>('unsigned');
  const [mine, setMine] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);

      try {
        const { data } = await api.get<EncounterWorklistItem[]>(
          '/encounters',
          { status: filter, mine: mine ? 'true' : undefined, pageSize: 100 },
          signal,
        );
        setItems(data);
      } catch (caught) {
        if (caught instanceof ApiError) setError(caught.message);
      } finally {
        setLoading(false);
      }
    },
    [filter, mine],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const escalating = items.filter((item) => (item.worst_news2 ?? 0) >= 5);
  const overdue = items.filter(
    (item) => item.status !== 'signed' && Number(item.age_hours) >= 24,
  );
  const inProgress = items.filter((item) => item.status === 'in_progress');

  return (
    <>
      <PageHeader
        title="Encounters"
        subtitle="Clinical documentation, observations and signing"
        actions={
          can('encounter:write') ? (
            <Button variant="primary">Open an encounter</Button>
          ) : null
        }
      />

      {escalating.length > 0 ? (
        <div className="mb-5">
          <Alert
            tone="critical"
            title={`${pluralise(escalating.length, 'patient')} scoring NEWS2 5 or above`}
          >
            {escalating.map((item) => item.patient_name).join(', ')} — at 5 the national early
            warning score calls for urgent clinical review, and at 7 for an emergency response.
          </Alert>
        </div>
      ) : null}

      <section aria-label="Documentation summary" className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="In this list"
          value={items.length}
          hint={FILTERS.find((f) => f.value === filter)?.hint}
          emphasis
        />
        <StatTile
          label="In progress now"
          value={inProgress.length}
          tone={inProgress.length > 0 ? 'info' : 'neutral'}
          hint="Consultation under way"
        />
        <StatTile
          label="Unsigned over 24h"
          value={overdue.length}
          tone={overdue.length > 0 ? 'warning' : 'good'}
          hint="Unbillable, and a compliance exposure"
        />
        <StatTile
          label="Needing urgent review"
          value={escalating.length}
          tone={escalating.length > 0 ? 'critical' : 'good'}
          hint="NEWS2 5 or above"
        />
      </section>

      <Card padded={false}>
        <div
          className="flex flex-wrap items-center justify-between gap-3 p-4"
          style={{ borderBottom: '1px solid var(--line)' }}
        >
          <div role="tablist" aria-label="Encounter filter" className="flex flex-wrap gap-1.5">
            {FILTERS.map((option) => {
              const active = filter === option.value;
              return (
                <button
                  key={option.value}
                  role="tab"
                  aria-selected={active}
                  title={option.hint}
                  onClick={() => setFilter(option.value)}
                  className="rounded-[var(--radius-md)] px-3 py-1.5 text-[0.8125rem] font-medium"
                  style={{
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    color: active ? 'var(--info-ink)' : 'var(--ink-secondary)',
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          {user?.staffProfileId ? (
            <label className="flex items-center gap-2 text-[0.8125rem]" style={{ color: 'var(--ink-secondary)' }}>
              <input
                type="checkbox"
                checked={mine}
                onChange={(event) => setMine(event.target.checked)}
                className="h-4 w-4"
              />
              Only mine
            </label>
          ) : null}
        </div>

        {error ? (
          <div className="p-4">
            <p className="text-[0.875rem]" style={{ color: 'var(--critical-ink)' }}>
              {error}
            </p>
          </div>
        ) : loading && items.length === 0 ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={48} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<IconStethoscope />}
            title={filter === 'unsigned' ? 'No documentation outstanding' : 'Nothing to show'}
            description={
              filter === 'unsigned'
                ? 'Every encounter has been signed. Signed notes are locked, and corrections are filed as amendments.'
                : 'No encounter matches this filter.'
            }
          />
        ) : (
          <div className="px-5 pb-1">
            <Table>
              <thead>
                <tr>
                  <Th>Patient</Th>
                  <Th>Presenting complaint</Th>
                  <Th width="10rem">Early warning</Th>
                  <Th>Clinician</Th>
                  <Th align="right">Age</Th>
                  <Th align="right" width="10rem">
                    Status
                  </Th>
                  <Th width="3rem">
                    <span className="sr-only">Open chart</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const ageHours = Number(item.age_hours);
                  const amendments = Number(item.amendment_count);

                  return (
                    <Tr key={item.id}>
                      <Td>
                        <span className="block font-medium" style={{ color: 'var(--ink)' }}>
                          {item.patient_name}
                        </span>
                        <span className="tabular text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                          {item.mrn} · {item.reference}
                        </span>
                      </Td>
                      <Td>
                        <span style={{ color: 'var(--ink-secondary)' }}>
                          {item.chief_complaint ?? '—'}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                          <Badge tone="neutral" dot>
                            {humanise(item.encounter_class)}
                          </Badge>
                          {item.diagnosis_count > 0 ? (
                            <span className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                              {pluralise(item.diagnosis_count, 'diagnosis', 'diagnoses')}
                            </span>
                          ) : null}
                          {amendments > 0 ? (
                            <Badge tone="info" dot>
                              {pluralise(amendments, 'amendment')}
                            </Badge>
                          ) : null}
                        </span>
                      </Td>
                      <Td>
                        <Badge tone={news2Tone(item.worst_news2)}>
                          {item.worst_news2 === null ? '—' : `NEWS2 ${item.worst_news2}`}
                        </Badge>
                        <span className="mt-0.5 block text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                          {news2Label(item.worst_news2)}
                        </span>
                      </Td>
                      <Td style={{ color: 'var(--ink-muted)' }}>
                        {item.provider_name}
                        {item.department_name ? (
                          <span className="block text-[0.75rem]">{item.department_name}</span>
                        ) : null}
                      </Td>
                      <Td numeric align="right">
                        <span
                          style={{
                            color:
                              item.status !== 'signed' && ageHours >= 24
                                ? 'var(--warning-ink)'
                                : 'var(--ink-muted)',
                          }}
                          title={formatDateTime(item.started_at)}
                        >
                          {ageHours < 24
                            ? `${ageHours.toFixed(1)}h`
                            : `${Math.round(ageHours / 24)}d`}
                        </span>
                      </Td>
                      <Td align="right">
                        <Badge tone={STATUS_TONE[item.status]}>{humanise(item.status)}</Badge>
                        {item.signed_at ? (
                          <span className="mt-0.5 block text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                            {formatRelative(item.signed_at)}
                          </span>
                        ) : null}
                        {item.requires_cosign && !item.cosigned_at ? (
                          <span className="mt-0.5 block text-[0.75rem]" style={{ color: 'var(--serious-ink)' }}>
                            Awaiting co-signature
                          </span>
                        ) : null}
                      </Td>
                      <Td align="right">
                        <Link
                          href={`/patients/${item.patient_id}`}
                          aria-label={`Open ${item.patient_name}'s chart`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)]"
                          style={{ color: 'var(--ink-muted)' }}
                        >
                          <IconChevronRight className="h-4 w-4" />
                        </Link>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </>
  );
}
