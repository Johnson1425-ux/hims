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
  ConsoleBadge,
  ConsoleButton,
  ConsoleCard,
  ConsoleTable,
  ConsoleTd,
  ConsoleTh,
} from './console-shell';

const field = {
  background: '#0b1220',
  color: '#e2e8f0',
  border: '1px solid #334155',
} as const;

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
      <ConsoleCard title="Subscription">
        <p className="text-[0.875rem]" style={{ color: '#64748b' }}>
          Loading…
        </p>
      </ConsoleCard>
    );
  }

  if (!subscription) {
    return (
      <ConsoleCard
        title="Subscription"
        subtitle="This hospital has no billing terms yet, so it is invisible to the billing run"
      >
        <ConsoleButton
          variant="primary"
          disabled={busy}
          onClick={() => void put({ status: 'active' })}
        >
          {busy ? 'Setting up…' : 'Set up billing'}
        </ConsoleButton>
      </ConsoleCard>
    );
  }

  const effective = Number(subscription.effective_amount_cents ?? 0);
  const outstanding = Number(subscription.outstanding_cents);
  const overdue = Number(subscription.overdue_cents);

  return (
    <ConsoleCard
      title="Subscription"
      subtitle={`${subscription.tier} · ${subscription.currency} · per ${subscription.billing_interval}`}
      action={
        !editing ? (
          <ConsoleButton onClick={() => setEditing(true)}>Change terms</ConsoleButton>
        ) : null
      }
    >
      {message ? (
        <div
          className="mb-4 rounded-[8px] px-3 py-2.5 text-[0.8125rem]"
          style={{ background: '#450a0a', color: '#fecaca' }}
        >
          {message}
        </div>
      ) : null}

      <div className="mb-4 grid gap-4 sm:grid-cols-4">
        <Figure
          label="Rate"
          value={formatMoney(effective, subscription.currency)}
          hint={subscription.has_negotiated_rate ? 'negotiated' : 'published price'}
        />
        <Figure label="Paid up to" value={subscription.current_period_end.slice(0, 10)} />
        <Figure
          label="Outstanding"
          value={formatMoney(outstanding, subscription.currency)}
        />
        <Figure
          label="Overdue"
          value={formatMoney(overdue, subscription.currency)}
          alarming={overdue > 0}
        />
      </div>

      {subscription.has_negotiated_rate ? (
        <div
          className="mb-4 rounded-[8px] px-3 py-2.5 text-[0.8125rem]"
          style={{ background: '#1e293b', color: '#cbd5e1' }}
        >
          This hospital is on a <strong>negotiated rate</strong> and will not follow changes to
          the price book. Clear it to put them back on the published price for their tier.
        </div>
      ) : null}

      {editing ? (
        <div className="mb-4 flex flex-col gap-3 rounded-[8px] p-3" style={{ background: '#0b1220' }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="rate" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
                Negotiated rate ({subscription.currency})
              </label>
              <input
                id="rate"
                inputMode="numeric"
                value={rate}
                placeholder="Leave empty to use the price book"
                onChange={(event) => setRate(event.target.value.replace(/[^0-9]/g, ''))}
                className="h-9 w-full rounded-[6px] px-3 text-[0.875rem] tabular-nums"
                style={field}
              />
            </div>
            <div>
              <label htmlFor="subStatus" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
                Status
              </label>
              <select
                id="subStatus"
                value={subStatus}
                onChange={(event) => setSubStatus(event.target.value)}
                className="h-9 w-full rounded-[6px] px-3 text-[0.875rem]"
                style={field}
              >
                <option value="trialing">Trialing — not invoiced</option>
                <option value="active">Active — invoiced each period</option>
                <option value="cancelled">Cancelled — not invoiced</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="subNotes" className="mb-1.5 block text-[0.8125rem]" style={{ color: '#94a3b8' }}>
              Notes
            </label>
            <input
              id="subNotes"
              value={notes}
              placeholder="Contract reference, who agreed it"
              onChange={(event) => setNotes(event.target.value)}
              className="h-9 w-full rounded-[6px] px-3 text-[0.875rem]"
              style={field}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <ConsoleButton
              variant="primary"
              disabled={busy}
              onClick={() =>
                void put({
                  amountCents: rate === '' ? null : Number(rate),
                  status: subStatus,
                  notes: notes.trim() || null,
                })
              }
            >
              {busy ? 'Saving…' : 'Save terms'}
            </ConsoleButton>
            <ConsoleButton onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </ConsoleButton>
            {subscription.has_negotiated_rate ? (
              <ConsoleButton
                disabled={busy}
                onClick={() => {
                  setRate('');
                  void put({ amountCents: null });
                }}
              >
                Back to the published price
              </ConsoleButton>
            ) : null}
          </div>
        </div>
      ) : null}

      <p className="mb-2 text-[0.75rem] tracking-[0.03em] uppercase" style={{ color: '#64748b' }}>
        Recent invoices
      </p>

      {invoices.length === 0 ? (
        <p className="text-[0.875rem]" style={{ color: '#64748b' }}>
          None issued yet.
        </p>
      ) : (
        <ConsoleTable
          head={
            <>
              <ConsoleTh>Invoice</ConsoleTh>
              <ConsoleTh>Period</ConsoleTh>
              <ConsoleTh align="right">Total</ConsoleTh>
              <ConsoleTh align="right">Balance</ConsoleTh>
              <ConsoleTh>Status</ConsoleTh>
            </>
          }
        >
          {invoices.map((invoice) => (
            <tr key={invoice.id}>
              <ConsoleTd>
                <span className="tabular-nums">{invoice.invoice_number}</span>
              </ConsoleTd>
              <ConsoleTd muted>
                <span className="text-[0.8125rem]">
                  {invoice.period_start.slice(0, 10)} → {invoice.period_end.slice(0, 10)}
                </span>
              </ConsoleTd>
              <ConsoleTd align="right">
                <span className="tabular-nums">
                  {formatMoney(Number(invoice.total_cents), invoice.currency)}
                </span>
              </ConsoleTd>
              <ConsoleTd align="right">
                <span className="tabular-nums" style={{ color: invoice.is_overdue ? '#fbbf24' : undefined }}>
                  {formatMoney(Number(invoice.balance_cents), invoice.currency)}
                </span>
              </ConsoleTd>
              <ConsoleTd>
                <ConsoleBadge value={invoice.status} />
                {invoice.is_overdue ? (
                  <div className="mt-1 text-[0.75rem]" style={{ color: '#fbbf24' }}>
                    {invoice.days_overdue}d overdue
                  </div>
                ) : null}
              </ConsoleTd>
            </tr>
          ))}
        </ConsoleTable>
      )}
    </ConsoleCard>
  );
}

function Figure({
  label,
  value,
  hint,
  alarming,
}: {
  label: string;
  value: string;
  hint?: string;
  alarming?: boolean;
}) {
  return (
    <div>
      <p className="text-[0.75rem] tracking-[0.03em] uppercase" style={{ color: '#64748b' }}>
        {label}
      </p>
      <p
        className="mt-1 text-[1rem] font-semibold tabular-nums"
        style={{ color: alarming ? '#fbbf24' : '#f1f5f9' }}
      >
        {value}
      </p>
      {hint ? (
        <p className="text-[0.75rem]" style={{ color: '#64748b' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
