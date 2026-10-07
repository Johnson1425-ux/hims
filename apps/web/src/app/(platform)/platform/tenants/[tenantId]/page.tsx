'use client';

/**
 * One hospital, and the three things the vendor can do to it: change its
 * plan, take it offline, bring it back.
 *
 * What is NOT on this page is as deliberate as what is. There is no "view as
 * this hospital", no patient search, no chart. The numbers are volumes. A
 * support question that genuinely needs clinical data is answered by a named
 * person inside that hospital under their own break-glass review, which is
 * logged and read by their privacy officer — not by a vendor shortcut whose
 * only oversight is this console.
 */
import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ApiError,
  platformApi,
  type AuditRow,
  type TenantDetail,
  type TenantStatus,
} from '@/lib/platform-api';
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

const TIERS = ['trial', 'standard', 'enterprise'] as const;

export default function TenantDetailPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = use(params);
  return (
    <ConsoleShell>
      <TenantDetailView tenantId={tenantId} />
    </ConsoleShell>
  );
}

function TenantDetailView({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [events, setEvents] = useState<AuditRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  const [pending, setPending] = useState<TenantStatus | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => setToken((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const [t, a] = await Promise.all([
          platformApi.get<TenantDetail>(`/tenants/${tenantId}`, undefined, controller.signal),
          platformApi.get<AuditRow[]>(
            '/audit',
            { tenantId, platformOnly: true, pageSize: 20 },
            controller.signal,
          ),
        ]);
        setTenant(t.data);
        setEvents(a.data);
        setStatus('ready');
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(caught instanceof ApiError ? caught.message : 'This hospital could not be loaded.');
        setStatus('error');
      }
    })();

    return () => controller.abort();
  }, [tenantId, token]);

  const changeStatus = async (next: TenantStatus) => {
    setBusy(true);
    setNotice(null);

    try {
      await platformApi.patch(`/tenants/${tenantId}/status`, {
        status: next,
        reason: reason.trim() || undefined,
      });
      setPending(null);
      setReason('');
      reload();
    } catch (caught) {
      setNotice(
        caught instanceof ApiError
          ? (caught.issues[0]?.message ?? caught.message)
          : 'The change could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  };

  const changeTier = async (tier: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await platformApi.patch(`/tenants/${tenantId}/plan`, { subscriptionTier: tier });
      reload();
    } catch (caught) {
      setNotice(caught instanceof ApiError ? caught.message : 'The plan could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  if (status === 'loading') {
    return (
      <p className="text-[0.875rem]" style={{ color: '#64748b' }}>
        Loading…
      </p>
    );
  }

  if (status === 'error' || !tenant) {
    return (
      <div className="rounded-[8px] px-4 py-3 text-[0.875rem]" style={{ background: '#450a0a', color: '#fecaca' }}>
        {error}
      </div>
    );
  }

  return (
    <>
      <div className="mb-5">
        <button
          type="button"
          onClick={() => router.push('/platform')}
          className="mb-2 text-[0.8125rem]"
          style={{ color: '#64748b' }}
        >
          ← All hospitals
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[1.375rem] font-semibold" style={{ color: '#f1f5f9' }}>
            {tenant.display_name}
          </h1>
          <ConsoleBadge value={tenant.status} />
          <ConsoleBadge value={tenant.subscription_tier} />
        </div>
        <p className="mt-1 text-[0.8125rem] tabular-nums" style={{ color: '#64748b' }}>
          {tenant.legal_name} · {tenant.slug} · {tenant.facility_code} · {tenant.timezone} ·{' '}
          {tenant.currency}
        </p>
      </div>

      {tenant.status !== 'active' ? (
        <div
          className="mb-5 rounded-[8px] px-4 py-3 text-[0.875rem]"
          style={{ background: '#78350f', color: '#fde68a' }}
        >
          <strong className="capitalize">{tenant.status}</strong>
          {tenant.status_reason ? ` — ${tenant.status_reason}` : null}
          {tenant.status_changed_at
            ? ` (${new Date(tenant.status_changed_at).toLocaleString()})`
            : null}
          <div className="mt-1 text-[0.8125rem]">
            Nobody at this hospital can sign in while it is {tenant.status}.
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="mb-5 rounded-[8px] px-4 py-3 text-[0.875rem]" style={{ background: '#450a0a', color: '#fecaca' }}>
          {notice}
        </div>
      ) : null}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <ConsoleStat label="Staff" value={tenant.active_user_count} hint={`${tenant.invited_user_count} invited`} />
        <ConsoleStat label="Patients" value={tenant.patient_count} />
        <ConsoleStat label="Sites" value={tenant.facility_count} />
        <ConsoleStat label="Departments" value={tenant.department_count} />
        <ConsoleStat
          label="Unreviewed break-glass"
          value={tenant.unreviewed_break_glass}
          tone="warning"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ConsoleCard title="Plan" subtitle="Takes effect immediately">
          <div className="flex flex-wrap gap-2">
            {TIERS.map((tier) => (
              <ConsoleButton
                key={tier}
                variant={tier === tenant.subscription_tier ? 'primary' : 'secondary'}
                disabled={busy || tier === tenant.subscription_tier}
                onClick={() => void changeTier(tier)}
              >
                <span className="capitalize">{tier}</span>
              </ConsoleButton>
            ))}
          </div>
        </ConsoleCard>

        <ConsoleCard
          title="Lifecycle"
          subtitle="Suspension signs everyone out immediately and blocks new sign-ins"
        >
          {pending ? (
            <div className="flex flex-col gap-3">
              <p className="text-[0.875rem]" style={{ color: '#cbd5e1' }}>
                {pending === 'active'
                  ? 'Bring this hospital back online?'
                  : `Take ${tenant.display_name} offline? Every live session ends at once.`}
              </p>
              <div>
                <label htmlFor="reason" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
                  Reason{pending === 'active' ? ' (optional)' : ''}
                </label>
                <input
                  id="reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Non-payment: invoice 2026-0041 overdue 60 days"
                  className="h-9 w-full rounded-[6px] px-3 text-[0.875rem]"
                  style={{ background: '#0b1220', color: '#e2e8f0', border: '1px solid #334155' }}
                />
                <p className="mt-1 text-[0.75rem]" style={{ color: '#64748b' }}>
                  Shown to whoever asks support why they are locked out, and recorded in this
                  hospital’s own audit trail.
                </p>
              </div>
              <div className="flex gap-2">
                <ConsoleButton
                  variant={pending === 'active' ? 'primary' : 'danger'}
                  disabled={busy || (pending !== 'active' && reason.trim().length === 0)}
                  onClick={() => void changeStatus(pending)}
                >
                  {busy ? 'Working…' : pending === 'active' ? 'Restore' : `Confirm ${pending}`}
                </ConsoleButton>
                <ConsoleButton onClick={() => setPending(null)} disabled={busy}>
                  Cancel
                </ConsoleButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tenant.status === 'active' ? (
                <>
                  <ConsoleButton variant="danger" onClick={() => setPending('suspended')}>
                    Suspend
                  </ConsoleButton>
                  <ConsoleButton variant="danger" onClick={() => setPending('archived')}>
                    Archive
                  </ConsoleButton>
                </>
              ) : tenant.status === 'archived' ? (
                <p className="text-[0.875rem]" style={{ color: '#64748b' }}>
                  Archived. Restoring an archived hospital is a data-retention decision and is
                  not done from the console.
                </p>
              ) : (
                <ConsoleButton variant="primary" onClick={() => setPending('active')}>
                  Restore
                </ConsoleButton>
              )}
            </div>
          )}
        </ConsoleCard>
      </div>

      <div className="mt-5">
        <ConsoleCard
          title="What the vendor has done here"
          subtitle={
            tenant.provisioned_by_email
              ? `Provisioned by ${tenant.provisioned_by_email}`
              : 'This hospital predates the console'
          }
          padded={false}
        >
          <div className="px-5 pb-4">
            <ConsoleTable
              head={
                <>
                  <ConsoleTh>When</ConsoleTh>
                  <ConsoleTh>Action</ConsoleTh>
                  <ConsoleTh>Operator</ConsoleTh>
                  <ConsoleTh>Detail</ConsoleTh>
                </>
              }
            >
              {events.length === 0 ? (
                <tr>
                  <ConsoleTd muted>Nothing yet.</ConsoleTd>
                </tr>
              ) : (
                events.map((event) => (
                  <tr key={event.id}>
                    <ConsoleTd muted>{new Date(event.occurred_at).toLocaleString()}</ConsoleTd>
                    <ConsoleTd>{event.action.replace(/^platform\./, '')}</ConsoleTd>
                    <ConsoleTd muted>{event.actor_label}</ConsoleTd>
                    <ConsoleTd muted>
                      {typeof event.metadata?.reason === 'string' ? event.metadata.reason : '—'}
                    </ConsoleTd>
                  </tr>
                ))
              )}
            </ConsoleTable>
          </div>
        </ConsoleCard>
      </div>

      <p className="mt-5 text-[0.8125rem]" style={{ color: '#475569' }}>
        Facilities, departments, staff and clinical configuration belong to this hospital and
        are managed from their own{' '}
        <Link href="/settings" style={{ color: '#64748b', textDecoration: 'underline' }}>
          settings screen
        </Link>
        , by their administrator.
      </p>
    </>
  );
}
