'use client';

/**
 * The fleet: every hospital in the deployment, and the form that creates one.
 *
 * The numbers here are deliberately VOLUMES — how many patients, how many
 * users, when the account was last active. Not names, not charts. A vendor
 * operator needs to know that a hospital exists, is paying, and is being
 * used; everything beyond that belongs to the hospital.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ApiError, platformApi, type PlatformSummary, type TenantRow } from '@/lib/platform-api';
import {
  ConsoleBadge,
  ConsoleButton,
  ConsoleCard,
  ConsoleShell,
  ConsoleStat,
  ConsoleTable,
  ConsoleTd,
  ConsoleTh,
} from '@/components/platform/console-shell';
import { ProvisionDialog } from '@/components/platform/provision-dialog';

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}

export default function PlatformHomePage() {
  return (
    <ConsoleShell>
      <Fleet />
    </ConsoleShell>
  );
}

function Fleet() {
  const [summary, setSummary] = useState<PlatformSummary | null>(null);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [chain, setChain] = useState<{ intact: boolean; brokenAtId: string | null } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [provisioning, setProvisioning] = useState(false);
  const [token, setToken] = useState(0);

  const reload = useCallback(() => setToken((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const [s, t, c] = await Promise.all([
          platformApi.get<PlatformSummary>('/summary', undefined, controller.signal),
          platformApi.get<TenantRow[]>('/tenants', { pageSize: 100 }, controller.signal),
          platformApi.get<{ intact: boolean; brokenAtId: string | null }>(
            '/audit/chain',
            undefined,
            controller.signal,
          ),
        ]);

        setSummary(s.data);
        setTenants(t.data);
        setChain(c.data);
        setStatus('ready');
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(caught instanceof ApiError ? caught.message : 'The console could not be loaded.');
        setStatus('error');
      }
    })();

    return () => controller.abort();
  }, [token]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tenants;
    return tenants.filter(
      (t) =>
        t.display_name.toLowerCase().includes(needle) ||
        t.legal_name.toLowerCase().includes(needle) ||
        t.slug.toLowerCase().includes(needle),
    );
  }, [tenants, query]);

  if (status === 'loading') {
    return (
      <p className="text-[0.875rem]" style={{ color: '#64748b' }}>
        Loading the fleet…
      </p>
    );
  }

  if (status === 'error') {
    return (
      <div
        className="rounded-[8px] px-4 py-3 text-[0.875rem]"
        style={{ background: '#450a0a', color: '#fecaca' }}
      >
        {error}
      </div>
    );
  }

  return (
    <>
      {/*
        The chain banner is the first thing on the page when it is broken.
        A tamper-evident log nobody looks at is a log, not evidence.
      */}
      {chain && !chain.intact ? (
        <div
          className="mb-5 rounded-[8px] px-4 py-3 text-[0.875rem]"
          style={{ background: '#450a0a', color: '#fecaca' }}
        >
          <strong>The audit hash chain does not reconcile</strong>, first at row{' '}
          {chain.brokenAtId}. Rows after a break cannot be trusted to be unaltered. Treat this
          as a security incident.
        </div>
      ) : null}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ConsoleStat label="Hospitals" value={summary?.tenant_count ?? '0'} hint={`${summary?.active_tenants ?? 0} active`} />
        <ConsoleStat label="Suspended" value={summary?.suspended_tenants ?? '0'} tone="warning" />
        <ConsoleStat label="Staff accounts" value={summary?.active_users ?? '0'} hint="across every hospital" />
        <ConsoleStat
          label="Unreviewed break-glass"
          value={summary?.unreviewed_break_glass ?? '0'}
          tone="warning"
          hint="emergency access awaiting a privacy officer"
        />
      </div>

      <ConsoleCard
        title="Hospitals"
        subtitle="Every tenant in this deployment"
        padded={false}
        action={
          <ConsoleButton variant="primary" onClick={() => setProvisioning(true)}>
            Provision a hospital
          </ConsoleButton>
        }
      >
        <div className="px-5 pb-3">
          <input
            type="search"
            value={query}
            placeholder="Filter by name or slug…"
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 w-full max-w-sm rounded-[6px] px-3 text-[0.875rem]"
            style={{ background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155' }}
          />
        </div>

        <div className="px-5 pb-4">
          <ConsoleTable
            head={
              <>
                <ConsoleTh>Hospital</ConsoleTh>
                <ConsoleTh>Status</ConsoleTh>
                <ConsoleTh>Plan</ConsoleTh>
                <ConsoleTh align="right">Staff</ConsoleTh>
                <ConsoleTh align="right">Patients</ConsoleTh>
                <ConsoleTh align="right">Last active</ConsoleTh>
              </>
            }
          >
            {visible.length === 0 ? (
              <tr>
                <ConsoleTd muted>
                  {tenants.length === 0
                    ? 'No hospitals yet. Provision the first one.'
                    : 'Nothing matches that filter.'}
                </ConsoleTd>
              </tr>
            ) : (
              visible.map((tenant) => (
                <tr key={tenant.id}>
                  <ConsoleTd>
                    <Link href={`/platform/tenants/${tenant.id}`} className="font-medium hover:underline">
                      {tenant.display_name}
                    </Link>
                    <div className="mt-0.5 text-[0.75rem] tabular-nums" style={{ color: '#64748b' }}>
                      {tenant.slug} · {tenant.facility_code} · {tenant.currency}
                    </div>
                  </ConsoleTd>
                  <ConsoleTd>
                    <ConsoleBadge value={tenant.status} />
                    {tenant.status !== 'active' && tenant.status_reason ? (
                      <div className="mt-1 max-w-[16rem] text-[0.75rem]" style={{ color: '#64748b' }}>
                        {tenant.status_reason}
                      </div>
                    ) : null}
                  </ConsoleTd>
                  <ConsoleTd>
                    <ConsoleBadge value={tenant.subscription_tier} />
                  </ConsoleTd>
                  <ConsoleTd align="right" muted>
                    <span className="tabular-nums">{tenant.active_user_count}</span>
                  </ConsoleTd>
                  <ConsoleTd align="right" muted>
                    <span className="tabular-nums">{tenant.patient_count}</span>
                  </ConsoleTd>
                  <ConsoleTd align="right" muted>
                    {relative(tenant.last_activity_at)}
                  </ConsoleTd>
                </tr>
              ))
            )}
          </ConsoleTable>
        </div>
      </ConsoleCard>

      <ProvisionDialog
        open={provisioning}
        onClose={() => setProvisioning(false)}
        onProvisioned={reload}
      />
    </>
  );
}
