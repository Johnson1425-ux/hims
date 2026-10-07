'use client';

/**
 * Reporting.
 *
 * Three sections, gated separately, because they answer to different people:
 * utilisation belongs to whoever runs the clinic, revenue to whoever chases
 * the money, and the compliance queue to whoever answers an auditor. A
 * clinician with report:operational sees the first and never learns the second
 * exists — the tabs are built from what the session can actually read, so the
 * screen does not advertise a locked door.
 *
 * Every one of these runs in a READ ONLY transaction server-side, so a report
 * cannot mutate a chart however it is written.
 *
 * Break-glass review is deliberately in here rather than tucked into settings.
 * Emergency access is only defensible because it is reviewed afterwards, and
 * an unreviewed queue is the first finding of any audit.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/layout/shell';
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Input,
  Meter,
  Skeleton,
  StatTile,
  Table,
  Tabs,
  Td,
  Th,
  Tr,
  type Tone,
} from '@/components/ui/primitives';
import { useSession } from '@/lib/session';
import {
  api,
  ApiError,
  type AccessLogEntry,
  type BreakGlassGrant,
  type PatientSummary,
  type RevenueReport,
  type UtilisationRow,
} from '@/lib/api';
import { PatientPicker } from '@/components/ui/patient-picker';
import { formatDateTime, formatMoney, formatNumber, formatRelative, humanise } from '@/lib/format';
import { IconChart, IconShield } from '@/components/layout/icons';

type Section = 'utilisation' | 'revenue' | 'compliance' | 'disclosures';

/** A no-show rate is not linear in concern: 10% is a bad week, 25% is a problem. */
function noShowTone(pct: number | null): Tone {
  if (pct === null) return 'neutral';
  if (pct >= 25) return 'critical';
  if (pct >= 15) return 'serious';
  if (pct >= 8) return 'warning';
  return 'good';
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export default function ReportsPage() {
  const { can } = useSession();

  const sections = useMemo(() => {
    const available: Array<{ value: Section; label: string; hint: string }> = [];
    if (can('report:operational')) {
      available.push({
        value: 'utilisation',
        label: 'Utilisation',
        hint: 'Throughput and no-show rate by clinician',
      });
    }
    if (can('report:financial')) {
      available.push({
        value: 'revenue',
        label: 'Revenue',
        hint: 'Payer mix, collection rate and denials',
      });
    }
    if (can('audit:read')) {
      available.push({
        value: 'compliance',
        label: 'Compliance',
        hint: 'Emergency access awaiting review',
      });
      available.push({
        value: 'disclosures',
        label: 'Disclosures',
        hint: 'Who opened one patient\u2019s record, and on what basis',
      });
    }
    return available;
  }, [can]);

  const [section, setSection] = useState<Section | null>(null);
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(isoDaysAgo(0));

  const [utilisation, setUtilisation] = useState<UtilisationRow[]>([]);
  const [revenue, setRevenue] = useState<RevenueReport | null>(null);
  const [grants, setGrants] = useState<BreakGlassGrant[]>([]);
  const [subject, setSubject] = useState<PatientSummary | null>(null);
  const [disclosures, setDisclosures] = useState<AccessLogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (section === null && sections.length > 0) setSection(sections[0]!.value);
  }, [section, sections]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!section) return;

      setLoading(true);
      setError(null);

      try {
        if (section === 'utilisation') {
          const { data } = await api.get<UtilisationRow[]>('/reports/utilisation', { from, to }, signal);
          setUtilisation(data);
        } else if (section === 'revenue') {
          const { data } = await api.get<RevenueReport>('/reports/revenue', { from, to }, signal);
          setRevenue(data);
        } else if (section === 'compliance') {
          const { data } = await api.get<BreakGlassGrant[]>('/reports/break-glass-review', undefined, signal);
          setGrants(data);
        } else if (subject) {
          // Running this report is itself an access to the record, and is
          // logged as one — which is why it needs a named patient rather than
          // offering a browsable list of everybody's access history.
          const { data } = await api.get<AccessLogEntry[]>(
            `/reports/patient-access-log/${subject.id}`,
            { from, to },
            signal,
          );
          setDisclosures(data);
        } else {
          setDisclosures(null);
        }
      } catch (caught) {
        if (caught instanceof ApiError) setError(caught.message);
      } finally {
        setLoading(false);
      }
    },
    [section, from, to, subject],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (sections.length === 0) {
    return (
      <>
        <PageHeader title="Reports" subtitle="Operational, financial and compliance reporting" />
        <Card>
          <EmptyState
            icon={<IconChart />}
            title="No reports are available to your role"
            description="Operational, financial and audit reporting are permissioned separately. Ask an administrator if you need one of them."
          />
        </Card>
      </>
    );
  }

  const bookedTotal = utilisation.reduce((sum, row) => sum + Number(row.booked), 0);
  const noShowTotal = utilisation.reduce((sum, row) => sum + Number(row.no_shows), 0);
  const completedTotal = utilisation.reduce((sum, row) => sum + Number(row.completed), 0);

  const billed = revenue?.byPayer.reduce((sum, row) => sum + Number(row.billed_cents ?? 0), 0) ?? 0;
  const collected =
    revenue?.byPayer.reduce((sum, row) => sum + Number(row.collected_cents ?? 0), 0) ?? 0;
  const outstanding =
    revenue?.byPayer.reduce((sum, row) => sum + Number(row.outstanding_cents ?? 0), 0) ?? 0;
  const denied =
    revenue?.topDenialReasons.reduce((sum, row) => sum + Number(row.denied_cents ?? 0), 0) ?? 0;

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Every report runs read-only, so it cannot alter a record however it is written"
      />

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        {/*
          Shared primitive rather than the hand-rolled row this used to be:
          same pills, now with arrow-key navigation and a single tab stop.
          No `idPrefix` — this is a filter, and there is no one panel it
          controls, so pointing `aria-controls` at something would be a lie.
        */}
        <Tabs tabs={sections} value={section} onChange={setSection} label="Report" />

        {section !== 'compliance' ? (
          <div className="flex items-end gap-2">
            <Input
              name="from"
              type="date"
              label="From"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
            />
            <Input
              name="to"
              type="date"
              label="To"
              value={to}
              min={from}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="mb-5">
          <Alert tone="critical" title="The report could not be run">
            {error}
          </Alert>
        </div>
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton height={88} />
          <Skeleton height={260} />
        </div>
      ) : section === 'utilisation' ? (
        <>
          <section aria-label="Throughput" className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Booked" value={formatNumber(bookedTotal)} emphasis />
            <StatTile label="Completed" value={formatNumber(completedTotal)} tone="good" />
            <StatTile
              label="Did not attend"
              value={formatNumber(noShowTotal)}
              tone={noShowTone(bookedTotal > 0 ? (noShowTotal / bookedTotal) * 100 : null)}
              hint="Each one is an empty slot that was paid for"
            />
            <StatTile
              label="No-show rate"
              value={
                bookedTotal > 0 ? `${((noShowTotal / bookedTotal) * 100).toFixed(1)}%` : '—'
              }
              tone={noShowTone(bookedTotal > 0 ? (noShowTotal / bookedTotal) * 100 : null)}
            />
          </section>

          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader
                title="By clinician"
                subtitle="Planned slot length against time actually taken — the gap is where a clinic runs late"
              />
            </div>

            {utilisation.length === 0 ? (
              <EmptyState icon={<IconChart />} title="No appointments in this period" />
            ) : (
              <div className="px-5 pb-1">
                <Table>
                  <thead>
                    <tr>
                      <Th>Clinician</Th>
                      <Th>Department</Th>
                      <Th align="right">Booked</Th>
                      <Th align="right">Completed</Th>
                      <Th align="right">Cancelled</Th>
                      <Th width="10rem">No-show rate</Th>
                      <Th align="right">Planned</Th>
                      <Th align="right">Actual</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {utilisation.map((row) => {
                      const rate = row.no_show_rate_pct === null ? null : Number(row.no_show_rate_pct);
                      const planned = row.avg_slot_minutes === null ? null : Number(row.avg_slot_minutes);
                      const actual = row.avg_actual_minutes === null ? null : Number(row.avg_actual_minutes);
                      const overrunning = planned !== null && actual !== null && actual > planned * 1.15;

                      return (
                        <Tr key={row.provider_id}>
                          <Td className="font-medium" style={{ color: 'var(--ink)' }}>
                            {row.display_name}
                          </Td>
                          <Td style={{ color: 'var(--ink-muted)' }}>{row.department ?? '—'}</Td>
                          <Td numeric align="right" className="font-medium">
                            {row.booked}
                          </Td>
                          <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                            {row.completed}
                          </Td>
                          <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                            {row.cancelled}
                          </Td>
                          <Td>
                            {rate === null ? (
                              <span className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                                —
                              </span>
                            ) : (
                              <>
                                <Meter
                                  value={rate}
                                  max={40}
                                  threshold={15}
                                  tone={noShowTone(rate)}
                                  label={`${row.display_name} no-show rate`}
                                  compact
                                />
                                <span className="tabular mt-0.5 block text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                                  {rate.toFixed(1)}% · {row.no_shows} missed
                                </span>
                              </>
                            )}
                          </Td>
                          <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                            {planned === null ? '—' : `${planned}m`}
                          </Td>
                          <Td numeric align="right">
                            <span style={{ color: overrunning ? 'var(--warning-ink)' : 'var(--ink-muted)' }}>
                              {actual === null ? '—' : `${actual}m`}
                            </span>
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
      ) : section === 'revenue' ? (
        <>
          <section aria-label="Revenue" className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Billed" value={formatMoney(billed)} emphasis />
            <StatTile
              label="Collected"
              value={formatMoney(collected)}
              tone="good"
              hint={billed > 0 ? `${((collected / billed) * 100).toFixed(1)}% of billed` : undefined}
            />
            <StatTile
              label="Outstanding"
              value={formatMoney(outstanding)}
              tone={outstanding > 0 ? 'warning' : 'good'}
            />
            <StatTile
              label="Denied"
              value={formatMoney(denied)}
              tone={denied > 0 ? 'serious' : 'good'}
              hint="Recoverable; this is where revenue hides"
            />
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card padded={false}>
              <div className="p-5 pb-0">
                <CardHeader title="By payer" subtitle="Collection rate is the number that matters" />
              </div>
              {revenue && revenue.byPayer.length > 0 ? (
                <div className="px-5 pb-1">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Payer</Th>
                        <Th align="right">Invoices</Th>
                        <Th align="right">Billed</Th>
                        <Th width="9rem">Collected</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {revenue.byPayer.map((row) => {
                        const rate = row.collection_rate_pct === null ? null : Number(row.collection_rate_pct);
                        return (
                          <Tr key={row.payer}>
                            <Td className="font-medium" style={{ color: 'var(--ink)' }}>
                              {row.payer}
                            </Td>
                            <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                              {row.invoices}
                            </Td>
                            <Td numeric align="right">
                              {formatMoney(Number(row.billed_cents ?? 0))}
                            </Td>
                            <Td>
                              <Meter
                                value={rate ?? 0}
                                max={100}
                                threshold={80}
                                tone={rate === null ? 'neutral' : rate >= 80 ? 'good' : rate >= 50 ? 'warning' : 'critical'}
                                label={`${row.payer} collection rate`}
                                compact
                              />
                              <span className="tabular mt-0.5 block text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                                {rate === null ? '—' : `${rate.toFixed(1)}%`}
                              </span>
                            </Td>
                          </Tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </div>
              ) : (
                <EmptyState icon={<IconChart />} title="No invoices in this period" />
              )}
            </Card>

            <Card padded={false}>
              <div className="p-5 pb-0">
                <CardHeader title="By service" subtitle="Where the billed value comes from" />
              </div>
              {revenue && revenue.byServiceCategory.length > 0 ? (
                <div className="px-5 pb-1">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Category</Th>
                        <Th align="right">Units</Th>
                        <Th align="right">Net</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {revenue.byServiceCategory.map((row) => (
                        <Tr key={row.category ?? 'uncategorised'}>
                          <Td style={{ color: 'var(--ink)' }}>
                            {row.category ? humanise(row.category) : 'Uncategorised'}
                          </Td>
                          <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                            {formatNumber(Number(row.units ?? 0))}
                          </Td>
                          <Td numeric align="right" className="font-medium">
                            {formatMoney(Number(row.net_cents ?? 0))}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              ) : (
                <EmptyState icon={<IconChart />} title="No billed services in this period" />
              )}
            </Card>

            <Card padded={false}>
              <div className="p-5 pb-0">
                <CardHeader
                  title="Denial reasons"
                  subtitle="Adjudicated in the selected range, by value — the recoverable list, worst first"
                />
              </div>
              {revenue && revenue.topDenialReasons.length > 0 ? (
                <div className="px-5 pb-1">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Code</Th>
                        <Th>Reason</Th>
                        <Th align="right">Times</Th>
                        <Th align="right">Value</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {revenue.topDenialReasons.map((row) => (
                        <Tr key={`${row.denial_code}-${row.description}`}>
                          <Td className="tabular" style={{ color: 'var(--ink)' }}>
                            {row.denial_code ?? '—'}
                          </Td>
                          <Td style={{ color: 'var(--ink-muted)' }}>{row.description ?? '—'}</Td>
                          <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                            {row.occurrences}
                          </Td>
                          <Td numeric align="right" className="font-medium">
                            {formatMoney(Number(row.denied_cents ?? 0))}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              ) : (
                <EmptyState icon={<IconChart />} title="Nothing denied" description="No claim was denied in the last 90 days." />
              )}
            </Card>

            <Card padded={false}>
              <div className="p-5 pb-0">
                <CardHeader title="Collections by method" subtitle="Settled payments only" />
              </div>
              {revenue && revenue.collectionsByMethod.length > 0 ? (
                <div className="px-5 pb-1">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Method</Th>
                        <Th align="right">Payments</Th>
                        <Th align="right">Total</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {revenue.collectionsByMethod.map((row) => (
                        <Tr key={row.method}>
                          <Td style={{ color: 'var(--ink)' }}>{humanise(row.method)}</Td>
                          <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                            {row.payments}
                          </Td>
                          <Td numeric align="right" className="font-medium">
                            {formatMoney(Number(row.total_cents ?? 0))}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              ) : (
                <EmptyState icon={<IconChart />} title="Nothing collected in this period" />
              )}
            </Card>
          </div>
        </>
      ) : section === 'disclosures' ? (
        <>
          <div className="mb-5">
            <Card>
              <CardHeader
                title="Accounting of disclosures"
                subtitle="HIPAA §164.528 — a patient is entitled to a list of who accessed their record"
              />
              <PatientPicker value={subject} onChange={setSubject} label="Whose record" />
              <p className="mt-3 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                Running this is itself an access to the record, and is logged as one. That is why it
                asks for a named patient rather than offering everybody's history to browse.
              </p>
            </Card>
          </div>

          {subject === null ? null : disclosures === null ? (
            <Card>
              <EmptyState icon={<IconShield />} title="No accesses in this period" />
            </Card>
          ) : (
            <Card padded={false}>
              <div className="p-5 pb-0">
                <CardHeader
                  title={`${formatNumber(disclosures.length)} access${disclosures.length === 1 ? '' : 'es'}`}
                  subtitle={`${subject.fullName} · ${subject.mrn} · ${from} to ${to}`}
                />
              </div>

              {disclosures.length === 0 ? (
                <EmptyState
                  icon={<IconShield />}
                  title="Nobody opened this record in this period"
                  description="Widen the dates if you are answering a request that goes further back."
                />
              ) : (
                <div className="px-5 pb-1">
                  <Table>
                    <thead>
                      <tr>
                        <Th>When</Th>
                        <Th>Who</Th>
                        <Th>What they did</Th>
                        <Th>On what basis</Th>
                        <Th align="right">Outcome</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {disclosures.map((entry, index) => (
                        <Tr key={`${entry.occurred_at}-${index}`}>
                          <Td numeric style={{ color: 'var(--ink-muted)' }}>
                            {formatDateTime(entry.occurred_at)}
                          </Td>
                          <Td>
                            <span className="block" style={{ color: 'var(--ink)' }}>
                              {entry.actor_label ?? 'Unknown'}
                            </span>
                            {entry.actor_role ? (
                              <span className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                                {humanise(entry.actor_role)}
                              </span>
                            ) : null}
                          </Td>
                          <Td style={{ color: 'var(--ink-secondary)' }}>
                            {humanise(entry.action)}
                            <span className="block text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                              {humanise(entry.resource_type)}
                            </span>
                          </Td>
                          <Td>
                            {entry.access_basis ? (
                              <Badge tone={entry.access_basis === 'break_glass' ? 'serious' : 'neutral'} dot>
                                {humanise(entry.access_basis)}
                              </Badge>
                            ) : (
                              <span style={{ color: 'var(--ink-muted)' }}>—</span>
                            )}
                          </Td>
                          <Td align="right">
                            <Badge tone={entry.outcome === 'denied' ? 'critical' : 'good'}>
                              {humanise(entry.outcome)}
                            </Badge>
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              )}
            </Card>
          )}
        </>
      ) : (
        <>
          <div className="mb-5">
            <Alert
              tone={grants.length > 0 ? 'serious' : 'good'}
              title={
                grants.length > 0
                  ? `${grants.length} emergency access${grants.length === 1 ? '' : 'es'} awaiting review`
                  : 'Nothing awaiting review'
              }
            >
              Break-glass access lets a clinician open a record they have no care relationship with,
              which is sometimes exactly right and always has to be accounted for. The review is
              what makes it defensible; an unreviewed queue is the first finding of any audit.
            </Alert>
          </div>

          <Card padded={false}>
            <div className="p-5 pb-0">
              <CardHeader
                title="Break-glass review queue"
                subtitle="What they did with the access, which is the question a review has to answer"
                action={<IconShield className="h-4 w-4" style={{ color: 'var(--ink-muted)' }} />}
              />
            </div>

            {grants.length === 0 ? (
              <EmptyState
                icon={<IconShield />}
                title="No emergency access to review"
                description="Every break-glass grant has been reviewed, or none has been used."
              />
            ) : (
              <div className="px-5 pb-1">
                <Table>
                  <thead>
                    <tr>
                      <Th>Who</Th>
                      <Th>Whose record</Th>
                      <Th>Stated reason</Th>
                      <Th align="right">Actions</Th>
                      <Th align="right">Granted</Th>
                      <Th align="right">Window</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {grants.map((grant) => {
                      const actions = Number(grant.actions_taken);
                      const expired = new Date(grant.expires_at).getTime() < Date.now();

                      return (
                        <Tr key={grant.id}>
                          <Td>
                            <span className="block font-medium" style={{ color: 'var(--ink)' }}>
                              {grant.accessed_by}
                            </span>
                            <span className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                              {grant.email}
                            </span>
                          </Td>
                          <Td>
                            <span className="block" style={{ color: 'var(--ink-secondary)' }}>
                              {grant.patient_name}
                            </span>
                            <span className="tabular text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                              {grant.mrn}
                            </span>
                          </Td>
                          <Td style={{ color: 'var(--ink-muted)' }}>{grant.justification}</Td>
                          <Td numeric align="right">
                            <Badge tone={actions === 0 ? 'warning' : 'info'}>
                              {actions === 0 ? 'None taken' : formatNumber(actions)}
                            </Badge>
                          </Td>
                          <Td numeric align="right" style={{ color: 'var(--ink-muted)' }}>
                            <span title={formatDateTime(grant.created_at)}>
                              {formatRelative(grant.created_at)}
                            </span>
                          </Td>
                          <Td align="right">
                            <Badge tone={expired ? 'neutral' : 'serious'}>
                              {expired ? 'Closed' : 'Still open'}
                            </Badge>
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
      )}
    </>
  );
}
