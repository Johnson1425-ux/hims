'use client';

/**
 * Find a patient.
 *
 * Shared by every screen that acts on one — booking, invoicing, prescribing —
 * because each of them searching its own way is how two screens end up with
 * different ideas of who is on the roster.
 *
 * Results show the masked contact detail the list endpoint returns, never the
 * full number: this control is used at a front desk with other people standing
 * at it, and the full record is one audited click away.
 *
 * Confirming identity is the point, not speed. Date of birth is shown beside
 * every name because two patients sharing a name is routine, and picking the
 * wrong one puts a prescription on the wrong chart.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type PatientSummary } from '@/lib/api';
import { formatAge, formatDate } from '@/lib/format';
import { Avatar, Badge, Skeleton } from './primitives';
import { IconSearch } from '@/components/layout/icons';

export function PatientPicker({
  value,
  onChange,
  label = 'Patient',
  error,
  autoFocus,
}: {
  value: PatientSummary | null;
  onChange: (patient: PatientSummary | null) => void;
  label?: string;
  error?: string;
  autoFocus?: boolean;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onClick = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const search = useCallback(async (text: string, signal: AbortSignal) => {
    if (text.trim().length < 2) {
      setResults([]);
      return;
    }

    setLoading(true);
    setFailure(null);

    try {
      const { data } = await api.get<PatientSummary[]>(
        '/patients',
        { q: text.trim(), pageSize: 8 },
        signal,
      );
      setResults(data);
    } catch (caught) {
      if (!signal.aborted) setFailure(caught instanceof ApiError ? caught.message : 'Search failed.');
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void search(query, controller.signal), 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, search]);

  if (value) {
    return (
      <div className="w-full">
        <span className="mb-1.5 block text-[0.8125rem] font-medium" style={{ color: 'var(--ink-secondary)' }}>
          {label}
        </span>
        <div
          className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] p-3"
          style={{ background: 'var(--surface-sunken)', border: '1px solid var(--line)' }}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <Avatar name={value.fullName} />
            <span className="min-w-0">
              <span className="block truncate font-medium" style={{ color: 'var(--ink)' }}>
                {value.fullName}
              </span>
              <span className="tabular block text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                {value.mrn} · born {formatDate(value.dateOfBirth)} · {formatAge(value.dateOfBirth, value.age)}
              </span>
            </span>
          </span>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setQuery('');
              setOpen(true);
            }}
            className="shrink-0 rounded-[var(--radius-sm)] px-2 py-1 text-[0.8125rem] font-medium"
            style={{ color: 'var(--accent)' }}
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full" ref={box}>
      <label htmlFor="patient-search" className="mb-1.5 block text-[0.8125rem] font-medium" style={{ color: 'var(--ink-secondary)' }}>
        {label}
      </label>

      <div className="relative">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
          style={{ color: 'var(--ink-muted)' }}
        >
          <IconSearch className="h-4 w-4" />
        </span>
        <input
          id="patient-search"
          autoFocus={autoFocus}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls="patient-results"
          placeholder="Name or record number"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          className="h-9.5 w-full rounded-[var(--radius-md)] pr-3 pl-9 text-[0.875rem]"
          style={{
            background: 'var(--surface)',
            color: 'var(--ink)',
            border: `1px solid ${error ? 'var(--critical)' : 'var(--line-strong)'}`,
          }}
        />
      </div>

      {error ? (
        <p className="mt-1.5 text-[0.75rem]" style={{ color: 'var(--critical-ink)' }}>
          {error}
        </p>
      ) : null}

      {open && query.trim().length >= 2 ? (
        <div
          id="patient-results"
          role="listbox"
          className="mt-2 max-h-72 overflow-y-auto rounded-[var(--radius-md)]"
          style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}
        >
          {loading ? (
            <div className="flex flex-col gap-2 p-3">
              <Skeleton height={40} />
              <Skeleton height={40} />
            </div>
          ) : failure ? (
            <p className="p-3 text-[0.8125rem]" style={{ color: 'var(--critical-ink)' }}>
              {failure}
            </p>
          ) : results.length === 0 ? (
            <p className="p-3 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
              Nobody matches “{query.trim()}”.
            </p>
          ) : (
            <ul>
              {results.map((patient) => (
                <li key={patient.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      onChange(patient);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
                    style={{ borderBottom: '1px solid var(--line)' }}
                  >
                    <Avatar name={patient.fullName} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.875rem] font-medium" style={{ color: 'var(--ink)' }}>
                        {patient.fullName}
                      </span>
                      <span className="tabular block text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                        {patient.mrn} · born {formatDate(patient.dateOfBirth)}
                        {patient.phoneMasked ? ` · ${patient.phoneMasked}` : ''}
                      </span>
                    </span>
                    {patient.status !== 'active' ? <Badge tone="warning">{patient.status}</Badge> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
