'use client';

/**
 * Recording a payment that arrived somewhere else.
 *
 * There is no payment provider here: the hospital pays by bank transfer or
 * mobile money, and an operator writes down that it landed. So the reference
 * field matters more than it looks — a CRDB transfer number or an M-Pesa
 * confirmation code is what someone reconciling a bank statement three months
 * from now will actually match on, and it is unrecoverable if not captured
 * when the payment is entered.
 *
 * The amount defaults to the full balance, because a payment in full is the
 * common case and retyping a figure already on screen is how a digit gets
 * dropped.
 */
import { useEffect, useState } from 'react';
import {
  ApiError,
  openPlatformInvoicePdf,
  platformApi,
  type SubscriptionInvoiceRow,
} from '@/lib/platform-api';
import { formatMoney } from '@/lib/format';
import { Alert, Badge, Button } from '@/components/ui/primitives';
import { Field, FormDialog, Select } from '@/components/ui/forms';
import { StatusBadge } from './console-shell';

const METHODS = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'mobile_money', label: 'Mobile money' },
  { value: 'card', label: 'Card' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
];

export function RecordPaymentDialog({
  invoice,
  onClose,
  onRecorded,
}: {
  invoice: SubscriptionInvoiceRow | null;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [receivedOn, setReceivedOn] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<SubscriptionInvoiceRow | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);

  // Re-seeded on open, and the full history is fetched so the operator can
  // see what has already been recorded before adding to it.
  useEffect(() => {
    if (!invoice) return;

    setAmount(String(invoice.balance_cents));
    setMethod('bank_transfer');
    setReference('');
    setReceivedOn(new Date().toISOString().slice(0, 10));
    setNotes('');
    setErrors({});
    setMessage(null);
    setDetail(null);
    setLinkNotice(null);

    const controller = new AbortController();
    void (async () => {
      try {
        const { data } = await platformApi.get<SubscriptionInvoiceRow>(
          `/billing/invoices/${invoice.id}`,
          undefined,
          controller.signal,
        );
        setDetail(data);
      } catch {
        // The form still works without the history.
      }
    })();

    return () => controller.abort();
  }, [invoice]);

  if (!invoice) return null;

  const balance = Number(invoice.balance_cents);

  const openPdf = async () => {
    try {
      await openPlatformInvoicePdf(invoice.id);
    } catch {
      setLinkNotice('Could not open the PDF.');
    }
  };

  /** Mints a FRESH link rather than reusing one: the emailed one may have expired. */
  const copyLink = async () => {
    try {
      const { data } = await platformApi.get<{ url: string; expiresInDays: number }>(
        `/billing/invoices/${invoice.id}/link`,
      );
      await navigator.clipboard?.writeText(data.url);
      setLinkNotice(`Link copied — valid ${data.expiresInDays} days.`);
    } catch {
      setLinkNotice('Could not copy the link.');
    }
  };

  const parsed = Number(amount);
  const invalidAmount = !Number.isInteger(parsed) || parsed <= 0 || parsed > balance;

  const submit = async () => {
    setErrors({});
    setMessage(null);

    try {
      await platformApi.post(`/billing/invoices/${invoice.id}/payments`, {
        amountCents: parsed,
        method,
        reference: reference.trim() || null,
        receivedOn: receivedOn || undefined,
        notes: notes.trim() || null,
      });
      onRecorded();
      onClose();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErrors(Object.fromEntries(caught.issues.map((i) => [i.field, i.message])));
        setMessage(caught.issues.length > 0 ? null : caught.message);
      } else {
        setMessage('Something went wrong. Please try again.');
      }
    }
  };

  const voidPayment = async (paymentId: string) => {
    const reason = window.prompt('Why is this payment being voided?');
    if (!reason?.trim()) return;

    try {
      const { data } = await platformApi.post<SubscriptionInvoiceRow>(
        `/billing/payments/${paymentId}/void`,
        { reason: reason.trim() },
      );
      setDetail(data);
      onRecorded();
    } catch (caught) {
      setMessage(
        caught instanceof ApiError ? caught.message : 'That payment could not be voided.',
      );
    }
  };

  const recorded = detail?.payments ?? [];

  return (
    <FormDialog
      open={invoice !== null}
      onClose={onClose}
      className="console-root"
      title="Record a payment"
      description={`${invoice.invoice_number} · ${invoice.tenant_name}`}
      submitLabel="Record payment"
      onSubmit={submit}
      message={message}
      disabled={invalidAmount}
      width="38rem"
    >
      <div
        className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[var(--radius-md)] px-3.5 py-3 text-[0.8125rem]"
        style={{ background: 'var(--surface-sunken)' }}
      >
        <Money label="Total" value={Number(invoice.total_cents)} currency={invoice.currency} />
        <Money label="Paid" value={Number(invoice.amount_paid_cents)} currency={invoice.currency} />
        <Money label="Outstanding" value={balance} currency={invoice.currency} emphasis />
        <span className="ml-auto flex items-center gap-1.5">
          <StatusBadge value={invoice.status} />
          {invoice.is_overdue ? <Badge tone="warning">{invoice.days_overdue}d late</Badge> : null}
        </span>
      </div>

      {/*
        The two things an operator reaches for when a hospital says they
        never got the invoice: look at what was sent, and get a fresh link
        to re-send. The emailed link expires after 90 days, so re-minting it
        is a real need rather than a convenience.
      */}
      <div className="-mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => void openPdf()}>
          Open the PDF
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => void copyLink()}>
          Copy the link we emailed
        </Button>
        {linkNotice ? (
          <span role="status" className="text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
            {linkNotice}
          </span>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="amountCents"
          label={`Amount (${invoice.currency})`}
          inputMode="numeric"
          value={amount}
          onChange={(event) => setAmount(event.target.value.replace(/[^0-9]/g, ''))}
          error={errors.amountCents ?? (invalidAmount ? `Between 1 and ${balance}.` : undefined)}
          hint={`${formatMoney(parsed || 0, invoice.currency)} — whole ${invoice.currency}, no decimal point`}
        />

        <Select
          name="method"
          label="How it arrived"
          value={method}
          options={METHODS}
          onChange={(event) => setMethod(event.target.value)}
        />

        <Field
          name="reference"
          label="Reference"
          value={reference}
          placeholder="CRDB-99812 or QGH7X2P1LM"
          onChange={(event) => setReference(event.target.value)}
          error={errors.reference}
          hint="The transfer number or confirmation code. This is what reconciliation is done on."
        />

        <Field
          name="receivedOn"
          label="Received on"
          type="date"
          value={receivedOn}
          onChange={(event) => setReceivedOn(event.target.value)}
          error={errors.receivedOn}
          hint="When the money landed, not when you are typing this."
        />
      </div>

      <Field
        name="notes"
        label="Notes"
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />

      {recorded.length > 0 ? (
        <div>
          <p
            className="mb-2 text-[0.75rem] font-medium tracking-[0.02em] uppercase"
            style={{ color: 'var(--ink-muted)' }}
          >
            Already recorded
          </p>
          <ul className="flex flex-col gap-1.5">
            {recorded.map((payment) => (
              <li
                key={payment.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-sm)] px-3 py-2 text-[0.8125rem]"
                style={{
                  background: 'var(--surface-sunken)',
                  color: payment.voided_at ? 'var(--ink-muted)' : 'var(--ink-secondary)',
                }}
              >
                <span
                  className="tabular font-medium"
                  style={{
                    textDecoration: payment.voided_at ? 'line-through' : undefined,
                    color: payment.voided_at ? 'var(--ink-muted)' : 'var(--ink)',
                  }}
                >
                  {formatMoney(Number(payment.amount_cents), payment.currency)}
                </span>
                <span className="tabular">{payment.received_on.slice(0, 10)}</span>
                <span className="capitalize">{payment.method.replace(/_/g, ' ')}</span>
                {payment.reference ? <span className="font-mono">{payment.reference}</span> : null}
                {payment.voided_at ? (
                  <Badge tone="neutral" dot>
                    voided: {payment.void_reason}
                  </Badge>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => void voidPayment(payment.id)}
                  >
                    Void
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {balance === 0 ? (
        <Alert tone="info">
          This invoice has no outstanding balance. There is nothing left to record against it.
        </Alert>
      ) : null}
    </FormDialog>
  );
}

function Money({
  label,
  value,
  currency,
  emphasis,
}: {
  label: string;
  value: number;
  currency: string;
  emphasis?: boolean;
}) {
  return (
    <span style={{ color: 'var(--ink-muted)' }}>
      {label}{' '}
      <strong
        className="tabular"
        style={{ color: emphasis && value > 0 ? 'var(--warning-ink)' : 'var(--ink)' }}
      >
        {formatMoney(value, currency)}
      </strong>
    </span>
  );
}
