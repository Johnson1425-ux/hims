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
import {
  ApiError,
  platformApi,
  type AuditRow,
  type BreakGlassRow,
} from '@/lib/platform-api';
import {
  ConsoleBadge,
  ConsoleButton,
  ConsoleCard,
  ConsoleShell,
  ConsoleTable,
  ConsoleTd,
  ConsoleTh,
} from '@/components/platform/console-shell';

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
        setError(caught instanceof ApiError ? caught.message : 'The audit view could not be loaded.');
        setStatus('error');
      }
    })();

    return () => controller.abort();
  }, [platformOnly]);

  if (status === 'loading') {
    return <p className="text-[0.875rem]" style={{ color: '#64748b' }}>Loading…</p>;
  }

  if (status === 'error') {
    return (
      <div className="rounded-[8px] px-4 py-3 text-[0.875rem]" style={{ background: '#450a0a', color: '#fecaca' }}>
        {error}
      </div>
    );
  }

  return (
    <>
      <div
        className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[8px] px-4 py-3"
        style={{
          background: chain?.intact ? '#052e16' : '#450a0a',
          color: chain?.intact ? '#86efac' : '#fecaca',
        }}
      >
        <div className="text-[0.875rem]">
          {chain?.intact ? (
            <>
              <strong>Hash chain reconciles.</strong> Every audit row, clinical and vendor,
              commits to the one before it — so a deleted or edited row would show up here.
            </>
          ) : (
            <>
              <strong>Hash chain broken at row {chain?.brokenAtId}.</strong> Rows after this
              point cannot be trusted to be unaltered. Treat as a security incident.
            </>
          )}
        </div>
        <ConsoleButton onClick={() => void verify()} disabled={checking}>
          {checking ? 'Checking…' : 'Re-check now'}
        </ConsoleButton>
      </div>

      <ConsoleCard
        title="Audit trail"
        subtitle={
          platformOnly
            ? 'Vendor actions, across every hospital'
            : 'Every audited action in the deployment, vendor and clinical'
        }
        padded={false}
        action={
          <ConsoleButton onClick={() => setPlatformOnly((v) => !v)}>
            {platformOnly ? 'Show everything' : 'Vendor actions only'}
          </ConsoleButton>
        }
      >
        <div className="px-5 pb-4">
          <ConsoleTable
            head={
              <>
                <ConsoleTh>When</ConsoleTh>
                <ConsoleTh>Action</ConsoleTh>
                <ConsoleTh>Hospital</ConsoleTh>
                <ConsoleTh>Actor</ConsoleTh>
                <ConsoleTh>Outcome</ConsoleTh>
              </>
            }
          >
            {events.length === 0 ? (
              <tr>
                <ConsoleTd muted>Nothing recorded yet.</ConsoleTd>
              </tr>
            ) : (
              events.map((event) => (
                <tr key={event.id}>
                  <ConsoleTd muted>
                    <span className="tabular-nums">
                      {new Date(event.occurred_at).toLocaleString()}
                    </span>
                  </ConsoleTd>
                  <ConsoleTd>
                    {event.action}
                    {typeof event.metadata?.reason === 'string' ? (
                      <div className="mt-0.5 max-w-[22rem] text-[0.75rem]" style={{ color: '#64748b' }}>
                        {event.metadata.reason}
                      </div>
                    ) : null}
                  </ConsoleTd>
                  <ConsoleTd muted>{event.tenant_slug ?? '—'}</ConsoleTd>
                  <ConsoleTd muted>
                    {event.actor_label ?? '—'}
                    {event.by_platform ? (
                      <span className="ml-2 text-[0.75rem]" style={{ color: '#f59e0b' }}>
                        vendor
                      </span>
                    ) : null}
                  </ConsoleTd>
                  <ConsoleTd>
                    <ConsoleBadge value={event.outcome} />
                  </ConsoleTd>
                </tr>
              ))
            )}
          </ConsoleTable>
        </div>
      </ConsoleCard>

      <div className="mt-5">
        <ConsoleCard
          title="Emergency access awaiting review"
          subtitle="Break-glass grants no privacy officer has signed off yet"
          padded={false}
        >
          <div className="px-5 pb-4">
            <p className="mb-3 text-[0.8125rem]" style={{ color: '#475569' }}>
              Deliberately without the patient or the clinician’s written justification — those
              belong to the hospital’s own review. What is here is enough to notice a hospital
              falling behind and raise it with them.
            </p>

            <ConsoleTable
              head={
                <>
                  <ConsoleTh>Hospital</ConsoleTh>
                  <ConsoleTh>Clinician</ConsoleTh>
                  <ConsoleTh>Taken</ConsoleTh>
                  <ConsoleTh>Grant</ConsoleTh>
                </>
              }
            >
              {glass.length === 0 ? (
                <tr>
                  <ConsoleTd muted>Nothing outstanding anywhere. </ConsoleTd>
                </tr>
              ) : (
                glass.map((row) => (
                  <tr key={row.id}>
                    <ConsoleTd>{row.tenant_name}</ConsoleTd>
                    <ConsoleTd muted>{row.clinician_name ?? '—'}</ConsoleTd>
                    <ConsoleTd muted>
                      <span className="tabular-nums">
                        {new Date(row.created_at).toLocaleDateString()}
                      </span>
                    </ConsoleTd>
                    <ConsoleTd>
                      <ConsoleBadge value={row.still_active ? 'active' : 'archived'} />
                    </ConsoleTd>
                  </tr>
                ))
              )}
            </ConsoleTable>
          </div>
        </ConsoleCard>
      </div>
    </>
  );
}
