'use client';

/**
 * One hospital's subscription terms, on its own page.
 *
 * The distinction this panel has to make legible is PUBLISHED PRICE versus
 * NEGOTIATED RATE. A hospital on the price book should follow it when the
 * book changes; a hospital on a signed contract must not. Those are opposite
 * behaviours, the difference is one nullable column, and an operator who
 * cannot see which applies will eventually re-price a customer by accident.
 * So the state is spelled out in words, and clearing the override is an
 * explicit action rather than emptying a field.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  platformApi,
  type SubscriptionInvoiceRow,
  type SubscriptionRow,
} from '@/lib/platform-api';
import { formatMoney } from '@/lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
} from '@/components/ui/primitives';
import { Field, Select } from '@/components/ui/forms';
import { StatusBadge } from './console-shell';

export function SubscriptionPanel({ tenantId }: { tenantId: string }) {
  const [subscription, setSubscription] = useState<SubscriptionRow | null>(null);
  const [invoices, setInvoices] = useState<SubscriptionInvoiceRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [token, setToken] = useState(0);

  const [editing, setEditing] = useState(false);
  const [rate, setRate] = useState('');
  const [subStatus, setSubStatus] = useState('active');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(() => setToken((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const [s, i] = await Promise.all([
          platformApi.get<SubscriptionRow | null>(
            `/tenants/${tenantId}/subscription`,
            undefined,
            controller.signal,
          ),
          platformApi.get<SubscriptionInvoiceRow[]>(
            '/billing/invoices',
            { tenantId, pageSize: 10 },
            controller.signal,
          ),
        ]);

        setSubscription(s.data);
        setInvoices(i.data);
        if (s.data) {
          setRate(s.data.override_cents ?? '');
          setSubStatus(s.data.status);
          setNotes(s.data.notes ?? '');
        }
        setStatus('ready');
      } catch {
        if (!controller.signal.aborted) setStatus('error');
      }
    })();

    return () => controller.abort();
  }, [tenantId, token]);

  const put = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setMessage(null);

    try {
      const { data } = await platformApi.put<SubscriptionRow>(
        `/tenants/${tenantId}/subscription`,
        patch,
      );
      setSubscription(data);
      setEditing(false);
      reload();
    } catch (caught) {
      setMessage(
        caught instanceof ApiError
          ? (caught.issues[0]?.message ?? caught.message)
          : 'That change could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (status === 'loading') {
    return (
      <Card>
        <CardHeader title="Subscription" />
        <Skeleton className="w-full" height={96} />
      </Card>
    );
  }

  if (status === 'error') {
    return (
      <Card>
        <CardHeader title="Subscription" />
        <Alert tone="critical" title="The subscription could not be loaded">
          Reload the page, or check that your console session is still valid.
        </Alert>
      </Card>
    );
  }

  if (!subscription) {
    return (
      <Card>
        <CardHeader
          title="Subscription"
          subtitle="This hospital has no billing terms yet, so it is invisible to the billing run"
        />
        <Button variant="primary" loading={busy} onClick={() => void put({ status: 'active' })}>
          Set up billing
        </Button>
      </Card>
    );
  }

  const effective = Number(subscription.effective_amount_cents ?? 0);
  const outstanding = Number(subscription.outstanding_cents);
  const overdue = Number(subscription.overdue_cents);

  return (
    <Card>
      <CardHeader
        title="Subscription"
        subtitle={`${subscription.tier} · ${subscription.currency} · per ${subscription.billing_interval}`}
        action={
          <div className="flex items-center gap-2">
            <StatusBadge value={subscription.status} />
            {!editing ? (
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                Change terms
              </Button>
            ) : null}
          </div>
        }
      />

      {message ? (
        <div className="mb-4">
          <Alert tone="critical">{message}</Alert>
        </div>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Rate"
          value={formatMoney(effective, subscription.currency)}
          hint={
            subscription.has_negotiated_rate ? (
              <Badge tone="info" dot>
                negotiated
              </Badge>
            ) : (
              'published price'
            )
          }
        />
        <StatTile
          label="Paid up to"
          value={subscription.current_period_end.slice(0, 10)}
          hint="next invoice covers from here"
        />
        <StatTile
          label="Outstanding"
          value={formatMoney(outstanding, subscription.currency)}
          hint={outstanding > 0 ? 'issued, not yet paid' : 'nothing owing'}
        />
        <StatTile
          label="Overdue"
          value={formatMoney(overdue, subscription.currency)}
          tone={overdue > 0 ? 'warning' : 'neutral'}
          hint={overdue > 0 ? 'past its payment terms' : 'nothing late'}
        />
      </div>

      {subscription.has_negotiated_rate ? (
        <div className="mb-4">
          <Alert tone="info" title="On a negotiated rate">
            This hospital will not follow changes to the price book. Clear the rate to put them
            back on the published price for their tier.
          </Alert>
        </div>
      ) : null}

      {editing ? (
        <div
          className="mb-4 flex flex-col gap-4 rounded-[var(--radius-md)] p-4"
          style={{ background: 'var(--surface-sunken)' }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              name="rate"
              label={`Negotiated rate (${subscription.currency})`}
              inputMode="numeric"
              value={rate}
              placeholder="Leave empty to use the price book"
              onChange={(event) => setRate(event.target.value.replace(/[^0-9]/g, ''))}
              hint="Whole units of the currency, no decimal point."
            />
            <Select
              name="subStatus"
              label="Status"
              value={subStatus}
              onChange={(event) => setSubStatus(event.target.value)}
              options={[
                { value: 'trialing', label: 'Trialing — not invoiced' },
                { value: 'active', label: 'Active — invoiced each period' },
                { value: 'cancelled', label: 'Cancelled — not invoiced' },
              ]}
            />
          </div>

          <Field
            name="subNotes"
            label="Notes"
            value={notes}
            placeholder="Contract reference, who agreed it"
            onChange={(event) => setNotes(event.target.value)}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={busy}
              onClick={() =>
                void put({
                  amountCents: rate === '' ? null : Number(rate),
                  status: subStatus,
                  notes: notes.trim() || null,
                })
              }
            >
              Save terms
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
            {subscription.has_negotiated_rate ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setRate('');
                  void put({ amountCents: null });
                }}
              >
                Back to the published price
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <p
        className="mb-2 text-[0.75rem] font-medium tracking-[0.02em] uppercase"
        style={{ color: 'var(--ink-muted)' }}
      >
        Recent invoices
      </p>

      {invoices.length === 0 ? (
        <p className="text-[0.875rem]" style={{ color: 'var(--ink-muted)' }}>
          None issued yet.
        </p>
      ) : (
        <Table className="min-w-[44rem]">
          <thead>
            <tr>
              <Th>Invoice</Th>
              <Th>Period</Th>
              <Th align="right">Total</Th>
              <Th align="right">Balance</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <Tr key={invoice.id}>
                <Td numeric className="font-medium">
                  {invoice.invoice_number}
                </Td>
                <Td numeric style={{ color: 'var(--ink-secondary)' }}>
                  <span className="text-[0.8125rem]">
                    {invoice.period_start.slice(0, 10)} → {invoice.period_end.slice(0, 10)}
                  </span>
                </Td>
                <Td align="right" numeric>
                  {formatMoney(Number(invoice.total_cents), invoice.currency)}
                </Td>
                <Td
                  align="right"
                  numeric
                  style={{
                    color: invoice.is_overdue ? 'var(--warning-ink)' : undefined,
                    fontWeight: invoice.is_overdue ? 600 : undefined,
                  }}
                >
                  {invoice.status === 'void' ? (
                    <span style={{ color: 'var(--ink-muted)' }}>—</span>
                  ) : (
                    formatMoney(Number(invoice.balance_cents), invoice.currency)
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge value={invoice.status} />
                    {invoice.is_overdue ? (
                      <Badge tone="warning">{invoice.days_overdue}d late</Badge>
                    ) : null}
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
