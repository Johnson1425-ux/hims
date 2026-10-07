'use client';

/**
 * What this hospital pays for the software.
 *
 * NOT to be confused with the Billing screen, which is what this hospital's
 * patients owe IT. Two ledgers, two companies' money, and the thing that
 * keeps them apart in a user's head is mostly wording — so this card says
 * "your subscription" and names the vendor's invoice numbers, which look
 * nothing like a patient invoice's.
 *
 * READ-ONLY, deliberately. Terms are a contract between two companies, not a
 * setting a hospital administrator can edit at 2am. What they can do here is
 * see what they pay, see what is outstanding, and get the PDF — which is the
 * whole of what an accounts clerk needs and nothing more.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  openOwnInvoicePdf,
  type OwnSubscriptionInvoice,
  type OwnSubscriptionView,
} from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { Alert, Badge, Button, Card, Skeleton, Table, Td, Th, Tr } from '@/components/ui/primitives';

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'good' | 'warning'> = {
  issued: 'info',
  partially_paid: 'info',
  paid: 'good',
  void: 'neutral',
};

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function SubscriptionCard(): React.ReactNode {
  const [view, setView] = useState<OwnSubscriptionView | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const { data } = await api.get<OwnSubscriptionView>(
          '/tenant/subscription',
          undefined,
          controller.signal,
        );
        setView(data);
        setStatus('ready');
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof ApiError ? caught.message : 'Your subscription could not be loaded.',
        );
        setStatus('error');
      }
    })();

    return () => controller.abort();
  }, []);

  const open = useCallback(async (invoice: OwnSubscriptionInvoice) => {
    setOpening(invoice.id);
    setError(null);

    try {
      await openOwnInvoicePdf(invoice.id);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'That invoice could not be opened.',
      );
    } finally {
      setOpening(null);
    }
  }, []);

  if (status === 'loading') return <Skeleton height={220} />;

  if (status === 'error') {
    return (
      <Card>
        <Alert tone="critical" title="Your subscription could not be loaded">
          {error ?? 'Please try again.'}
        </Alert>
      </Card>
    );
  }

  const subscription = view?.subscription ?? null;
  const invoices = view?.invoices ?? [];
  const outstanding = view?.outstanding_cents ?? 0;
  const overdue = view?.overdue_cents ?? 0;

  if (!subscription) {
    return (
      <Card>
        <p className="text-[0.875rem]" style={{ color: 'var(--ink-secondary)' }}>
          No subscription terms have been set up for this hospital yet. Nothing is being billed.
        </p>
      </Card>
    );
  }

  const currency = subscription.currency;
  const onTrial = subscription.status === 'trialing';

  return (
    <Card padded={false}>
      <div className="p-5 pb-0">
        {/*
          No heading: the tab above already says "Your subscription", and
          repeating it just pushes the numbers further down. The one thing
          worth saying here is which of the two billing screens this is.
        */}
        <p className="mb-4 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
          What this hospital pays for the software. Separate from the Billing screen, which is
          what your patients owe you.
        </p>

        {error ? (
          <div className="mb-4">
            <Alert tone="critical">{error}</Alert>
          </div>
        ) : null}

        {overdue > 0 ? (
          <div className="mb-4">
            <Alert tone="warning" title="There is an overdue invoice">
              {formatMoney(overdue, currency)} is past its due date. Your account is unaffected —
              nothing has been restricted — but please settle it or get in touch if something is
              wrong with the invoice.
            </Alert>
          </div>
        ) : null}

        <div className="mb-4 grid gap-4 sm:grid-cols-4">
          <Figure
            label="Plan"
            value={subscription.tier.charAt(0).toUpperCase() + subscription.tier.slice(1)}
            hint={onTrial ? 'on trial' : undefined}
          />
          <Figure
            label="Rate"
            value={
              subscription.amount_cents === null
                ? '—'
                : formatMoney(Number(subscription.amount_cents), currency)
            }
            hint={subscription.amount_cents === null ? 'not yet billed' : `per ${subscription.billing_interval}`}
          />
          <Figure
            label={onTrial ? 'Trial ends' : 'Next invoice'}
            value={day(subscription.trial_ends_on ?? subscription.current_period_end)}
          />
          <Figure
            label="Outstanding"
            value={formatMoney(outstanding, currency)}
            tone={overdue > 0 ? 'warning' : undefined}
          />
        </div>
      </div>

      {invoices.length === 0 ? (
        <div className="px-5 pb-5">
          <p className="text-[0.875rem]" style={{ color: 'var(--ink-muted)' }}>
            No invoices yet.
            {onTrial ? ' Nothing is billed while you are on trial.' : null}
          </p>
        </div>
      ) : (
        <div className="px-5 pb-1">
          <Table>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Period</Th>
                <Th align="right">Total</Th>
                <Th align="right">Balance</Th>
                <Th>Status</Th>
                <Th align="right">Document</Th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <Tr key={invoice.id} className={invoice.status === 'void' ? 'opacity-60' : undefined}>
                  <Td className="font-medium" style={{ color: 'var(--ink)' }}>
                    <span className="tabular">{invoice.invoice_number}</span>
                    <div className="mt-0.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
                      due {day(invoice.due_on)}
                    </div>
                  </Td>
                  <Td style={{ color: 'var(--ink-muted)' }}>
                    <span className="text-[0.8125rem]">
                      {day(invoice.period_start)} — {day(invoice.period_end)}
                    </span>
                  </Td>
                  <Td align="right" numeric>
                    {formatMoney(Number(invoice.total_cents), invoice.currency)}
                  </Td>
                  <Td
                    align="right"
                    numeric
                    style={{ color: invoice.is_overdue ? 'var(--warning-ink)' : undefined }}
                  >
                    {formatMoney(Number(invoice.balance_cents), invoice.currency)}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[invoice.status] ?? 'neutral'}>
                      {invoice.status.replace(/_/g, ' ')}
                    </Badge>
                    {invoice.is_overdue ? (
                      <div className="mt-1 text-[0.75rem]" style={{ color: 'var(--warning-ink)' }}>
                        {invoice.days_overdue} days overdue
                      </div>
                    ) : null}
                  </Td>
                  <Td align="right">
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={opening === invoice.id}
                      onClick={() => void open(invoice)}
                    >
                      Open PDF
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      <div className="px-5 pt-3 pb-5">
        <p className="text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
          Invoices are emailed to everyone here who can change hospital settings, and also appear
          in your notifications. Payment details are on each invoice. If something looks wrong,
          reply to the invoice email rather than paying it.
        </p>
      </div>
    </Card>
  );
}

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'warning';
}): React.ReactNode {
  return (
    <div>
      <p
        className="text-[0.75rem] tracking-[0.03em] uppercase"
        style={{ color: 'var(--ink-muted)' }}
      >
        {label}
      </p>
      <p
        className="mt-1 text-[1.0625rem] font-semibold tabular"
        style={{ color: tone === 'warning' ? 'var(--warning-ink)' : 'var(--ink)' }}
      >
        {value}
      </p>
      {hint ? (
        <p className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
