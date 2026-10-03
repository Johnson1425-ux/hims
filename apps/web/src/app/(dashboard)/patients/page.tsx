'use client';

/**
 * Patient roster.
 *
 * The search row is the whole page, really. Front-desk staff arrive with one
 * of three things — a name said out loud, an MRN read off a card, or a phone
 * number — so all three resolve from the same field, and the exact-match
 * identifier lookups go through blind indexes server-side rather than
 * decrypting the roster.
 *
 * Note what is NOT shown in the list: full phone numbers and national IDs.
 * A roster screen is visible to anyone standing at the desk, so contact
 * details are masked until someone opens the individual record — which is an
 * audited read.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/layout/shell';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui/primitives';
import { useSession } from '@/lib/session';
import { api, ApiError, type PatientSummary } from '@/lib/api';
import { formatAge, formatDate, formatRelative, humanise } from '@/lib/format';
import { IconPatients, IconPlus, IconSearch } from '@/components/layout/icons';

type SortKey = 'name' | 'registered' | 'last_seen';

export default function PatientsPage() {
  const { can } = useSession();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('name');
  const [page, setPage] = useState(1);
  const [patients, setPatients] = useState<PatientSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pageSize = 25;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);

      try {
        const { data, meta } = await api.get<PatientSummary[]>(
          '/patients',
          { q: query.trim() || undefined, sort, page, pageSize },
          signal,
        );
        setPatients(data);
        setTotal((meta?.total as number) ?? 0);
      } catch (caught) {
        if (caught instanceof ApiError) setError(caught.message);
      } finally {
        setLoading(false);
      }
    },
    [query, sort, page],
  );

  useEffect(() => {
    const controller = new AbortController();
    // Debounced so typing an MRN does not fire — and audit — a search per key.
    const timer = window.setTimeout(() => void load(controller.signal), 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <PageHeader
        title="Patients"
        subtitle={loading ? 'Loading roster…' : `${total.toLocaleString()} registered`}
        actions={
          can('patient:write') ? (
            <Button variant="primary" icon={<IconPlus />}>
              Register patient
            </Button>
          ) : null
        }
      />

      <Card padded={false}>
        {/* Filters sit in one row above the table, as a single control group. */}
        <div
          className="flex flex-wrap items-end gap-3 p-4"
          style={{ borderBottom: '1px solid var(--line)' }}
        >
          <div className="min-w-[16rem] flex-1">
            <Input
              name="patient-search"
              label="Find a patient"
              placeholder="Name, MRN, or phone number"
              leading={<IconSearch className="h-4 w-4" />}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              hint="An exact phone number or national ID is matched without decrypting the roster."
            />
          </div>

          <div>
            <label
              htmlFor="sort"
              className="mb-1.5 block text-[0.8125rem] font-medium"
              style={{ color: 'var(--ink-secondary)' }}
            >
              Sort by
            </label>
            <select
              id="sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
              className="h-9.5 rounded-[var(--radius-md)] px-3 text-[0.875rem]"
              style={{
                background: 'var(--surface)',
                color: 'var(--ink)',
                border: '1px solid var(--line-strong)',
              }}
            >
              <option value="name">Family name</option>
              <option value="registered">Recently registered</option>
              <option value="last_seen">Recently seen</option>
            </select>
          </div>
        </div>

        {error ? (
          <div className="p-4">
            <p className="text-[0.875rem]" style={{ color: 'var(--critical-ink)' }}>
              {error}
            </p>
          </div>
        ) : loading && patients.length === 0 ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height={44} />
            ))}
          </div>
        ) : patients.length === 0 ? (
          <EmptyState
            icon={<IconPatients />}
            title={query ? 'No patients match that search' : 'No patients registered yet'}
            description={
              query
                ? 'Check the spelling, or try the medical record number.'
                : 'Register the first patient to get started.'
            }
            action={
              can('patient:write') ? (
                <Button variant="primary" icon={<IconPlus />}>
                  Register patient
                </Button>
              ) : null
            }
          />
        ) : (
          <div className="px-5 pb-1">
            <Table>
              <thead>
                <tr>
                  <Th>Patient</Th>
                  <Th>MRN</Th>
                  <Th>Date of birth</Th>
                  <Th>Age</Th>
                  <Th>Sex</Th>
                  <Th>Primary clinician</Th>
                  <Th>Contact</Th>
                  <Th>Last seen</Th>
                  <Th align="right">Status</Th>
                </tr>
              </thead>
              <tbody>
                {patients.map((patient) => (
                  <Tr key={patient.id} href={`/patients/${patient.id}`}>
                    <Td>
                      <span className="flex items-center gap-2.5">
                        <Avatar name={patient.fullName} size={30} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium" style={{ color: 'var(--ink)' }}>
                            {patient.fullName}
                          </span>
                          {patient.preferredName ? (
                            <span className="block truncate text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                              Prefers &ldquo;{patient.preferredName}&rdquo;
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </Td>
                    <Td numeric>{patient.mrn}</Td>
                    <Td numeric>{formatDate(patient.dateOfBirth)}</Td>
                    <Td numeric>{formatAge(patient.dateOfBirth, patient.age)}</Td>
                    <Td className="capitalize">{patient.sexAtBirth}</Td>
                    <Td>{patient.primaryProviderName ?? '—'}</Td>
                    {/* Masked on purpose: a roster is a public-facing screen. */}
                    <Td numeric style={{ color: 'var(--ink-muted)' }}>
                      {patient.phoneMasked ?? '—'}
                    </Td>
                    <Td style={{ color: 'var(--ink-muted)' }}>
                      {patient.lastSeenAt ? formatRelative(patient.lastSeenAt) : 'Never'}
                    </Td>
                    <Td align="right">
                      <Badge
                        tone={
                          patient.status === 'active'
                            ? 'good'
                            : patient.status === 'deceased'
                              ? 'neutral'
                              : 'warning'
                        }
                        dot={patient.status === 'active'}
                      >
                        {humanise(patient.status)}
                      </Badge>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}

        {totalPages > 1 ? (
          <div
            className="flex items-center justify-between gap-3 p-4"
            style={{ borderTop: '1px solid var(--line)' }}
          >
            <p className="tabular text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
              Page {page} of {totalPages}
            </p>
            <div className="flex gap-2">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}
