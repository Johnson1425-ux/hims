'use client';

/**
 * Oversight: what the vendor did, and where hospitals are falling behind on
 * their own emergency-access reviews.
 *
 * The break-glass table shows no patient and no justification text — only
 * that an access happened, who took it and whether it has been reviewed. A
 * vendor operator needs to know a hospital has forty unreviewed emergency
 * accesses so they can raise it with the customer. Whose records those were
 * is the hospital's business and their privacy officer's.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError, platformApi, type AuditRow, type BreakGlassRow } from '@/lib/platform-api';
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
} from '@/components/ui/primitives';
import { ConsoleShell, PageHeader, StatusBadge } from '@/components/platform/console-shell';

export default function AuditPage() {
  return (
    <ConsoleShell>
      <Audit />
    </ConsoleShell>
  );
}

function Audit() {
  const [events, setEvents] = useState<AuditRow[]>([]);
  const [glass, setGlass] = useState<BreakGlassRow[]>([]);
  const [chain, setChain] = useState<{ intact: boolean; brokenAtId: string | null } | null>(null);
  const [platformOnly, setPlatformOnly] = useState(true);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const verify = useCallback(async () => {
    setChecking(true);
    try {
      const { data } = await platformApi.get<{ intact: boolean; brokenAtId: string | null }>(
        '/audit/chain',
      );
      setChain(data);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const [a, b, c] = await Promise.all([
          platformApi.get<AuditRow[]>('/audit', { platformOnly, pageSize: 60 }, controller.signal),
          platformApi.get<BreakGlassRow[]>(
            '/break-glass',
            { unreviewedOnly: true, pageSize: 40 },
            controller.signal,
          ),
          platformApi.get<{ intact: boolean; brokenAtId: string | null }>(
            '/audit/chain',
            undefined,
            controller.signal,
          ),
        ]);

        setEvents(a.data);
        setGlass(b.data);
        setChain(c.data);
        setStatus('ready');
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof ApiError ? caught.message : 'The audit view could not be loaded.',
        );
        setStatus('error');
      }
    })();

    return () => controller.abort();
  }, [platformOnly]);

  if (status === 'loading') {
    return (
      <>
        <PageHeader title="Audit" />
        <Card>
          <Skeleton className="w-full" height={220} />
        </Card>
      </>
    );
  }

  if (status === 'error') {
    return (
      <>
        <PageHeader title="Audit" />
        <Alert tone="critical" title="The audit view could not be loaded">
          {error}
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Audit"
        subtitle="What the vendor did, and what hospitals have not yet reviewed"
      />

      <div className="mb-5">
        <Alert
          tone={chain?.intact ? 'good' : 'critical'}
          title={
            chain?.intact
              ? 'Hash chain reconciles'
              : `Hash chain broken at row ${chain?.brokenAtId}`
          }
          action={
            <Button size="sm" variant="secondary" loading={checking} onClick={() => void verify()}>
              {checking ? 'Checking…' : 'Re-check now'}
            </Button>
          }
        >
          {chain?.intact
            ? 'Every audit row, clinical and vendor, commits to the one before it — so a deleted or edited row would show up here.'
            : 'Rows after this point cannot be trusted to be unaltered. Treat as a security incident.'}
        </Alert>
      </div>

      <Card>
        <CardHeader
          title="Audit trail"
          subtitle={
            platformOnly
              ? 'Vendor actions, across every hospital'
              : 'Every audited action in the deployment, vendor and clinical'
          }
          action={
            <Button size="sm" variant="secondary" onClick={() => setPlatformOnly((v) => !v)}>
              {platformOnly ? 'Show everything' : 'Vendor actions only'}
            </Button>
          }
        />

        <Table className="min-w-[52rem]">
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Action</Th>
              <Th>Hospital</Th>
              <Th>Actor</Th>
              <Th>Outcome</Th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <Td colSpan={5}>
                  <EmptyState
                    title="Nothing recorded yet"
                    description={
                      platformOnly
                        ? 'No vendor action has been taken in this deployment.'
                        : 'The audit log is empty.'
                    }
                  />
                </Td>
              </tr>
            ) : (
              events.map((event) => (
                <Tr key={event.id}>
                  <Td numeric style={{ color: 'var(--ink-secondary)' }}>
                    {new Date(event.occurred_at).toLocaleString()}
                  </Td>
                  <Td>
                    <span className="font-mono text-[0.8125rem]">{event.action}</span>
                    {typeof event.metadata?.reason === 'string' ? (
                      <div
                        className="mt-0.5 max-w-[22rem] text-[0.75rem]"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        {event.metadata.reason}
                      </div>
                    ) : null}
                  </Td>
                  <Td style={{ color: 'var(--ink-secondary)' }}>{event.tenant_slug ?? '—'}</Td>
                  <Td style={{ color: 'var(--ink-secondary)' }}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {event.actor_label ?? '—'}
                      {/*
                        Only worth marking when the list is mixed. On the
                        vendor-only view it was on every single row, which is
                        just noise down the column.
                      */}
                      {!platformOnly && event.by_platform ? (
                        <span
                          className="rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[0.6875rem] font-semibold tracking-[0.02em] uppercase"
                          style={{ background: 'var(--vendor-soft)', color: 'var(--vendor-ink)' }}
                        >
                          vendor
                        </span>
                      ) : null}
                    </span>
                  </Td>
                  <Td>
                    {/*
                      A DENIED action is the system working — a permission
                      check that fired — so it is not dressed as an incident.
                      Only `error` is.
                    */}
                    <Badge
                      tone={
                        event.outcome === 'success'
                          ? 'good'
                          : event.outcome === 'denied'
                            ? 'warning'
                            : 'critical'
                      }
                    >
                      <span className="capitalize">{event.outcome.replace(/_/g, ' ')}</span>
                    </Badge>
                  </Td>
                </Tr>
              ))
            )}
          </tbody>
        </Table>
      </Card>

      <div className="mt-5">
        <Card>
          <CardHeader
            title="Emergency access awaiting review"
            subtitle="Break-glass grants no privacy officer has signed off yet"
          />

          <p className="-mt-2 mb-4 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
            Deliberately without the patient or the clinician’s written justification — those
            belong to the hospital’s own review. What is here is enough to notice a hospital
            falling behind and raise it with them.
          </p>

          <Table>
            <thead>
              <tr>
                <Th>Hospital</Th>
                <Th>Clinician</Th>
                <Th>Taken</Th>
                <Th>Grant</Th>
              </tr>
            </thead>
            <tbody>
              {glass.length === 0 ? (
                <tr>
                  <Td colSpan={4}>
                    <EmptyState
                      title="Nothing outstanding anywhere"
                      description="Every hospital has reviewed its emergency accesses."
                    />
                  </Td>
                </tr>
              ) : (
                glass.map((row) => (
                  <Tr key={row.id}>
                    <Td>{row.tenant_name}</Td>
                    <Td style={{ color: 'var(--ink-secondary)' }}>{row.clinician_name ?? '—'}</Td>
                    <Td numeric style={{ color: 'var(--ink-secondary)' }}>
                      {new Date(row.created_at).toLocaleDateString()}
                    </Td>
                    <Td>
                      <StatusBadge value={row.still_active ? 'active' : 'archived'} />
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
