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
  Alert,
  Button,
  Card,
  EmptyState,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui/primitives';
import {
  ConsoleShell,
  PageHeader,
  StatusBadge,
} from '@/components/platform/console-shell';
import { IconPlus, IconSearch } from '@/components/layout/icons';
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
      <>
        <PageHeader title="Hospitals" subtitle="Every tenant in this deployment" />
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((n) => (
            <Card key={n}>
              <Skeleton className="w-24" height={12} />
              <Skeleton className="mt-3 w-16" height={28} />
            </Card>
          ))}
        </div>
        <Card>
          <Skeleton className="w-full" height={200} />
        </Card>
      </>
    );
  }

  if (status === 'error') {
    return (
      <>
        <PageHeader title="Hospitals" />
        <Alert tone="critical" title="The console could not be loaded">
          {error}
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Hospitals"
        subtitle="Every tenant in this deployment"
        action={
          <Button variant="primary" icon={<IconPlus />} onClick={() => setProvisioning(true)}>
            Provision a hospital
          </Button>
        }
      />

      {/*
        The chain banner is the first thing on the page when it is broken.
        A tamper-evident log nobody looks at is a log, not evidence.
      */}
      {chain && !chain.intact ? (
        <div className="mb-5">
          <Alert tone="critical" title="The audit hash chain does not reconcile">
            First at row {chain.brokenAtId}. Rows after a break cannot be trusted to be
            unaltered. Treat this as a security incident.
          </Alert>
        </div>
      ) : null}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Hospitals"
          value={summary?.tenant_count ?? '0'}
          hint={`${summary?.active_tenants ?? 0} active`}
        />
        <StatTile
          label="Suspended"
          value={summary?.suspended_tenants ?? '0'}
          tone={Number(summary?.suspended_tenants ?? 0) > 0 ? 'serious' : 'neutral'}
          hint={Number(summary?.suspended_tenants ?? 0) > 0 ? 'cannot sign in' : 'none offline'}
        />
        <StatTile
          label="Staff accounts"
          value={summary?.active_users ?? '0'}
          hint="across every hospital"
        />
        <StatTile
          label="Unreviewed break-glass"
          value={summary?.unreviewed_break_glass ?? '0'}
          tone={Number(summary?.unreviewed_break_glass ?? 0) > 0 ? 'warning' : 'neutral'}
          hint="emergency access awaiting a privacy officer"
        />
      </div>

      <Card>
        {/*
          No heading here: the page is already called Hospitals, and a second
          copy of the word only competed with the filter for the same row —
          which at phone width squeezed it to one word per line.
        */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
            {query.trim()
              ? `${visible.length} of ${tenants.length} match “${query.trim()}”`
              : `${tenants.length} hospital${tenants.length === 1 ? '' : 's'}, newest first`}
          </p>

          <div className="relative w-full sm:w-64">
            <label htmlFor="tenant-filter" className="sr-only">
              Filter hospitals by name or slug
            </label>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
              style={{ color: 'var(--ink-muted)' }}
            >
              <IconSearch />
            </span>
            <input
              id="tenant-filter"
              type="search"
              value={query}
              placeholder="Filter by name or slug…"
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 w-full rounded-[var(--radius-md)] pr-3 pl-9 text-[0.875rem]"
              style={{
                background: 'var(--surface-sunken)',
                color: 'var(--ink)',
                border: '1px solid var(--line)',
              }}
            />
          </div>
        </div>

        {/* Six columns do not fit a phone. Scrolling the table beats wrapping
            a hospital's name to one word per line. */}
        <Table className="min-w-[46rem]">
          <thead>
            <tr>
              <Th>Hospital</Th>
              <Th>Status</Th>
              <Th>Plan</Th>
              <Th align="right">Staff</Th>
              <Th align="right">Patients</Th>
              <Th align="right">Last active</Th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <Td colSpan={6}>
                  {tenants.length === 0 ? (
                    <EmptyState
                      title="No hospitals yet"
                      description="Provisioning one creates the tenant, its encryption key, its first site and its first administrator."
                      action={
                        <Button variant="primary" onClick={() => setProvisioning(true)}>
                          Provision the first hospital
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      title="Nothing matches that filter"
                      description={`No hospital’s name or slug contains “${query.trim()}”.`}
                      action={
                        <Button variant="secondary" onClick={() => setQuery('')}>
                          Clear the filter
                        </Button>
                      }
                    />
                  )}
                </Td>
              </tr>
            ) : (
              visible.map((tenant) => (
                <Tr key={tenant.id}>
                  <Td>
                    <Link
                      href={`/platform/tenants/${tenant.id}`}
                      className="font-medium hover:underline"
                      style={{ color: 'var(--ink)' }}
                    >
                      {tenant.display_name}
                    </Link>
                    <div
                      className="tabular mt-0.5 text-[0.75rem]"
                      style={{ color: 'var(--ink-muted)' }}
                    >
                      {tenant.slug} · {tenant.facility_code} · {tenant.currency}
                    </div>
                  </Td>
                  <Td>
                    <StatusBadge value={tenant.status} />
                    {tenant.status !== 'active' && tenant.status_reason ? (
                      <div
                        className="mt-1 max-w-[16rem] text-[0.75rem]"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        {tenant.status_reason}
                      </div>
                    ) : null}
                  </Td>
                  <Td>
                    <StatusBadge value={tenant.subscription_tier} />
                  </Td>
                  <Td align="right" numeric>
                    {tenant.active_user_count}
                  </Td>
                  <Td align="right" numeric>
                    {tenant.patient_count}
                  </Td>
                  <Td align="right" style={{ color: 'var(--ink-secondary)' }}>
                    {relative(tenant.last_activity_at)}
                  </Td>
                </Tr>
              ))
            )}
          </tbody>
        </Table>
      </Card>

      <ProvisionDialog
        open={provisioning}
        onClose={() => setProvisioning(false)}
        onProvisioned={reload}
      />
    </>
  );
}
