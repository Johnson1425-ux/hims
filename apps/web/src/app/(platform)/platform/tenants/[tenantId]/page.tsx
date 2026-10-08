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
import {
  ApiError,
  platformApi,
  type AuditRow,
  type TenantDetail,
  type TenantStatus,
} from '@/lib/platform-api';
import { SubscriptionPanel } from '@/components/platform/subscription-panel';
import {
  Alert,
  Avatar,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
  cx,
} from '@/components/ui/primitives';
import { Field } from '@/components/ui/forms';
import { ConsoleShell, PageHeader, StatusBadge } from '@/components/platform/console-shell';

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
        setError(
          caught instanceof ApiError ? caught.message : 'This hospital could not be loaded.',
        );
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
      <>
        <PageHeader title="Loading…" back={{ href: '/platform', label: 'All hospitals' }} />
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[0, 1, 2, 3, 4].map((n) => (
            <Card key={n}>
              <Skeleton className="w-20" height={12} />
              <Skeleton className="mt-3 w-12" height={24} />
            </Card>
          ))}
        </div>
      </>
    );
  }

  if (status === 'error' || !tenant) {
    return (
      <>
        <PageHeader title="Hospital" back={{ href: '/platform', label: 'All hospitals' }} />
        <Alert tone="critical" title="This hospital could not be loaded">
          {error}
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={tenant.display_name}
        back={{ href: '/platform', label: 'All hospitals' }}
        badges={
          <>
            <StatusBadge value={tenant.status} />
            <StatusBadge value={tenant.subscription_tier} />
          </>
        }
        subtitle={
          <span className="tabular">
            {tenant.legal_name} · {tenant.slug} · {tenant.facility_code} · {tenant.timezone} ·{' '}
            {tenant.currency}
          </span>
        }
      />

      {tenant.status !== 'active' ? (
        <div className="mb-5">
          <Alert
            tone={tenant.status === 'archived' ? 'neutral' : 'serious'}
            title={
              <span className="capitalize">
                {tenant.status}
                {tenant.status_reason ? ` — ${tenant.status_reason}` : null}
              </span>
            }
          >
            Nobody at this hospital can sign in while it is {tenant.status}.
            {tenant.status_changed_at
              ? ` Changed ${new Date(tenant.status_changed_at).toLocaleString()}.`
              : null}
          </Alert>
        </div>
      ) : null}

      {notice ? (
        <div className="mb-5">
          <Alert tone="critical">{notice}</Alert>
        </div>
      ) : null}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Staff"
          value={tenant.active_user_count}
          hint={`${tenant.invited_user_count} invited`}
        />
        <StatTile label="Patients" value={tenant.patient_count} />
        <StatTile label="Sites" value={tenant.facility_count} />
        <StatTile label="Departments" value={tenant.department_count} />
        <StatTile
          label="Unreviewed break-glass"
          value={tenant.unreviewed_break_glass}
          tone={Number(tenant.unreviewed_break_glass) > 0 ? 'warning' : 'neutral'}
          hint={
            Number(tenant.unreviewed_break_glass) > 0
              ? 'their privacy officer’s to review'
              : 'all reviewed'
          }
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Plan"
            subtitle="Takes effect immediately. The negotiated rate, if any, is set below."
          />
          {/*
            A radio group rather than three buttons: the tier is one choice
            out of three with one of them already true, and a row of buttons
            where the current one is disabled reads as broken rather than
            as selected.
          */}
          <fieldset disabled={busy}>
            <legend className="sr-only">Subscription tier</legend>
            <div
              className="inline-flex rounded-[var(--radius-md)] p-0.5"
              style={{ background: 'var(--surface-sunken)' }}
            >
              {TIERS.map((tier) => {
                const active = tier === tenant.subscription_tier;
                return (
                  <label
                    key={tier}
                    className={cx(
                      'cursor-pointer rounded-[var(--radius-sm)] px-3.5 py-1.5 text-[0.875rem] capitalize',
                      'transition-colors duration-100 select-none',
                      busy && 'cursor-not-allowed opacity-60',
                    )}
                    style={
                      active
                        ? {
                            background: 'var(--surface)',
                            color: 'var(--ink)',
                            fontWeight: 600,
                            boxShadow: 'var(--shadow-sm)',
                          }
                        : { color: 'var(--ink-secondary)' }
                    }
                  >
                    <input
                      type="radio"
                      name="tier"
                      value={tier}
                      checked={active}
                      onChange={() => void changeTier(tier)}
                      className="sr-only"
                    />
                    {tier}
                  </label>
                );
              })}
            </div>
          </fieldset>
        </Card>

        <Card>
          <CardHeader
            title="Lifecycle"
            subtitle="Suspension signs everyone out immediately and blocks new sign-ins"
          />
          {pending ? (
            <div className="flex flex-col gap-3">
              <Alert tone={pending === 'active' ? 'info' : 'serious'}>
                {pending === 'active'
                  ? 'Bring this hospital back online?'
                  : `Take ${tenant.display_name} offline? Every live session ends at once.`}
              </Alert>

              <Field
                name="reason"
                label={`Reason${pending === 'active' ? ' (optional)' : ''}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Non-payment: invoice 2026-0041 overdue 60 days"
                hint="Shown to whoever asks support why they are locked out, and recorded in this hospital’s own audit trail."
              />

              <div className="flex flex-wrap gap-2">
                <Button
                  variant={pending === 'active' ? 'primary' : 'danger'}
                  loading={busy}
                  disabled={busy || (pending !== 'active' && reason.trim().length === 0)}
                  onClick={() => void changeStatus(pending)}
                >
                  {pending === 'active' ? 'Restore' : `Confirm ${pending}`}
                </Button>
                <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tenant.status === 'active' ? (
                <>
                  <Button variant="danger" onClick={() => setPending('suspended')}>
                    Suspend
                  </Button>
                  <Button variant="secondary" onClick={() => setPending('archived')}>
                    Archive
                  </Button>
                </>
              ) : tenant.status === 'archived' ? (
                <p className="text-[0.875rem]" style={{ color: 'var(--ink-muted)' }}>
                  Archived. Restoring an archived hospital is a data-retention decision and is
                  not done from the console.
                </p>
              ) : (
                <Button variant="primary" onClick={() => setPending('active')}>
                  Restore
                </Button>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-5">
        <BillingContacts tenant={tenant} />
      </div>

      <div className="mt-5">
        <SubscriptionPanel tenantId={tenantId} />
      </div>

      <div className="mt-5">
        <Card>
          <CardHeader
            title="What the vendor has done here"
            subtitle={
              tenant.provisioned_by_email
                ? `Provisioned by ${tenant.provisioned_by_email}`
                : 'This hospital predates the console'
            }
          />
          <Table className="min-w-[48rem]">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Action</Th>
                <Th>Operator</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 ? (
                <tr>
                  <Td colSpan={4}>
                    <EmptyState
                      title="Nothing yet"
                      description="No vendor operator has acted on this hospital."
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
                      <span className="font-mono text-[0.8125rem]">
                        {event.action.replace(/^platform\./, '')}
                      </span>
                    </Td>
                    <Td style={{ color: 'var(--ink-secondary)' }}>{event.actor_label}</Td>
                    <Td style={{ color: 'var(--ink-secondary)' }}>
                      {typeof event.metadata?.reason === 'string' ? event.metadata.reason : '—'}
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
        </Card>
      </div>

      <p className="mt-5 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
        Facilities, departments, staff and clinical configuration belong to this hospital and
        are managed from their own{' '}
        <Link href="/settings" className="underline" style={{ color: 'var(--ink-secondary)' }}>
          settings screen
        </Link>
        , by their administrator.
      </p>
    </>
  );
}


/* ===========================================================================
 * Billing contacts
 *
 * The people this hospital's invoices and payment receipts are addressed to,
 * and therefore the people an operator chasing an overdue invoice should
 * write to. Until this existed the only email on the page was the vendor
 * operator who provisioned the hospital, and finding a customer contact
 * meant opening the database.
 *
 * The list is EXACTLY the set the notifications go to — holders of
 * `tenant:settings`. Showing anyone else would make this a staff directory,
 * which is not the vendor's to browse.
 * ======================================================================== */

function BillingContacts({ tenant }: { tenant: TenantDetail }) {
  const contacts = tenant.billing_contacts ?? [];
  const addresses = contacts.map((c) => c.email).join(', ');
  const [copied, setCopied] = useState(false);

  return (
    <Card>
      <CardHeader
        title="Billing contacts"
        subtitle="Everyone here receives this hospital's invoices and payment receipts"
        action={
          contacts.length > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(addresses);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : `Copy ${contacts.length === 1 ? 'address' : 'all addresses'}`}
            </Button>
          ) : null
        }
      />

      {contacts.length === 0 ? (
        /*
         * Not an empty state — a fault. This hospital is being invoiced and
         * nobody is being told, which used to show up only as a warning in
         * the worker's log.
         */
        <Alert tone="warning" title="Nobody here can be invoiced">
          No active user at this hospital holds <code>tenant:settings</code>, so its invoices
          and payment receipts are queued for nobody. Ask them to give an administrator that
          permission before the next billing run.
        </Alert>
      ) : (
        <ul className="flex flex-col gap-2">
          {contacts.map((contact) => (
            <li
              key={contact.id}
              className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] px-3 py-2"
              style={{ background: 'var(--surface-sunken)' }}
            >
              <Avatar name={contact.full_name} size={28} />
              <span className="text-[0.875rem] font-medium" style={{ color: 'var(--ink)' }}>
                {contact.full_name}
              </span>
              <a
                href={`mailto:${contact.email}`}
                className="text-[0.8125rem] hover:underline"
                style={{ color: 'var(--accent)' }}
              >
                {contact.email}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
